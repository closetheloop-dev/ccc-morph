import type { NoteStore, WorkspaceNote } from "./note-store";
import { ViewerInput, type ViewerInputToken } from "./viewer-input";

type NoteViewerControls = {
  close: () => void;
  submit: (notes: WorkspaceNote[]) => Promise<void>;
  // Optional so tests and callers that do not support these can omit them. Each runs
  // an external editor and then reopens the picker (via refresh).
  edit?: (note: WorkspaceNote) => Promise<void>;
  add?: () => Promise<void>;
  // Opens the editor pre-filled with the wrapped program's recent output.
  capture?: () => Promise<void>;
  // Suspends the picker and opens the history of past responses and plans; the picker is
  // refreshed on return (whether an item was captured or the history was dismissed).
  history?: () => void | Promise<void>;
};

type Tab = "active" | "archive";

function visible(value: string): string {
  return (
    value
      // Normalize CRLF to LF first so real line breaks split cleanly and are not left
      // as an escaped \x0d; a remaining bare \r is escaped as a control below.
      .replace(/\r\n/g, "\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal control bytes must not render in the picker
      .replace(/\x1b/g, "\\x1b")
      // Escapes every C0 control and DEL except tab (\x09) and newline (\x0a). \x0d
      // (a bare carriage return) is included so it cannot move the cursor.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal control bytes must not render in the picker
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (character) => {
        return `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`;
      })
  );
}

function clip(value: string, width: number): string {
  if (width <= 1) return "";
  const characters = Array.from(value);
  return characters.length <= width ? value : `${characters.slice(0, width - 1).join("")}…`;
}

// Render a stored UTC timestamp in the viewer's local time as "YYYY-MM-DD HH:MM".
function formatLocal(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 16).replace("T", " ");
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export class NoteViewer {
  readonly #store: NoteStore;
  readonly #controls: NoteViewerControls;
  readonly #input: ViewerInput;
  #active = false;
  #tab: Tab = "active";
  #notes: WorkspaceNote[] = [];
  #index = 0;
  #previewScroll = 0;
  #selected = new Set<string>();
  #busy = false;
  #confirmDelete: string | null = null;
  #message = "";

  constructor(store: NoteStore, controls: NoteViewerControls) {
    this.#store = store;
    this.#controls = controls;
    this.#input = new ViewerInput((token) => this.#handleToken(token));
  }

  get active(): boolean {
    return this.#active;
  }

  open(): void {
    if (this.#active) return;
    this.#notes = this.#store.load();
    this.#active = true;
    this.#tab = "active";
    this.#index = 0;
    this.#previewScroll = 0;
    this.#selected.clear();
    this.#message = "";
    this.#input.reset();
    this.render();
  }

  // Reload from the store and re-render without resetting the tab or cursor. Used to
  // return to the picker after editing a note in an external editor.
  refresh(message = ""): void {
    this.#notes = this.#store.load();
    this.#active = true;
    this.#confirmDelete = null;
    this.#message = message;
    const notes = this.#visibleNotes();
    this.#index = Math.max(0, Math.min(this.#index, Math.max(0, notes.length - 1)));
    this.#previewScroll = 0;
    this.#input.reset();
    this.render();
  }

  deactivate(): void {
    this.#active = false;
    this.#input.reset();
  }

  close(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#input.reset();
    process.stdout.write("\x1b[0m\x1b[2J\x1b[H");
    this.#controls.close();
  }

  resize(): void {
    if (this.#active) this.render();
  }

  handleInput(bytes: Uint8Array): void {
    if (this.#busy) return;
    this.#input.feed(bytes);
  }

  #handleToken(token: ViewerInputToken): void {
    if (!this.#active || this.#busy) return;
    // Arrows move between notes to select; everything else can scroll the note.
    if (token === "up") {
      this.#moveSelection(-1);
      return;
    }
    if (token === "down") {
      this.#moveSelection(1);
      return;
    }
    if (token === "page-up") {
      this.#scrollPreview(-this.#pageStep());
      return;
    }
    if (token === "page-down") {
      this.#scrollPreview(this.#pageStep());
      return;
    }
    if (this.#confirmDelete !== null) {
      if (token === 0x79 || token === 0x59) void this.#deleteConfirmed();
      else {
        this.#confirmDelete = null;
        this.#message = "delete cancelled";
        this.render();
      }
      return;
    }
    if (token === 0x71 || token === 0x1b) this.close();
    // Paging a note (less/vim conventions): line, half page, full page.
    else if (token === 0x6a)
      this.#scrollPreview(1); // j — line down
    else if (token === 0x6b)
      this.#scrollPreview(-1); // k — line up
    else if (token === 0x64 || token === 0x04)
      this.#scrollPreview(this.#halfStep()); // d / Ctrl-D — half page down
    else if (token === 0x75 || token === 0x15)
      this.#scrollPreview(-this.#halfStep()); // u / Ctrl-U — half page up
    else if (token === 0x66 || token === 0x06)
      this.#scrollPreview(this.#pageStep()); // f / Ctrl-F — page down
    else if (token === 0x62 || token === 0x02)
      this.#scrollPreview(-this.#pageStep()); // b / Ctrl-B — page up
    else if (token === 0x67)
      this.#scrollPreview(Number.NEGATIVE_INFINITY); // g — jump to top
    else if (token === 0x47)
      this.#scrollPreview(Number.POSITIVE_INFINITY); // G — jump to bottom
    // Acting on notes.
    else if (token === 0x09)
      this.#switchTab(); // Tab
    else if (token === 0x20)
      this.#toggle(); // Space
    else if (token === 0x0d || token === 0x0a)
      void this.#submit(); // Enter
    else if (token === 0x72)
      void this.#restore(); // r
    else if (token === 0x44)
      this.#askDelete(); // D (Shift-D) — delete, kept off the d scroll key
    else if (token === 0x65)
      void this.#edit(); // e — edit the current note
    else if (token === 0x61)
      void this.#add(); // a — add a new note
    else if (token === 0x63)
      void this.#capture(); // c — capture the program's latest output
    else if (token === 0x43) void this.#history(); // C — response/plan history
  }

  #layout(): { rows: number; columns: number; listRows: number; previewRows: number } {
    const rows = Math.max(process.stdout.rows ?? 24, 8);
    const columns = Math.max(process.stdout.columns ?? 80, 20);
    const listRows = Math.max(3, Math.min(8, Math.floor((rows - 4) / 2)));
    // Reserve three footer rows: scroll help, create help, and manage/status.
    const previewRows = Math.max(1, rows - (1 + listRows + 1) - 3);
    return { rows, columns, listRows, previewRows };
  }

  #previewLines(note: WorkspaceNote, columns: number): string[] {
    return visible(note.text)
      .split(/\r?\n/)
      .flatMap((line) => {
        if (line.length === 0) return [""];
        const characters = Array.from(line);
        const wrapped: string[] = [];
        for (let offset = 0; offset < characters.length; offset += columns) {
          wrapped.push(characters.slice(offset, offset + columns).join(""));
        }
        return wrapped;
      });
  }

  #pageStep(): number {
    return this.#layout().previewRows;
  }

  #halfStep(): number {
    return Math.max(1, Math.floor(this.#layout().previewRows / 2));
  }

  render(): void {
    if (!this.#active) return;
    const { rows, columns, listRows, previewRows } = this.#layout();
    const notes = this.#visibleNotes();
    this.#index = Math.max(0, Math.min(this.#index, Math.max(0, notes.length - 1)));
    const start = Math.max(
      0,
      Math.min(this.#index - Math.floor(listRows / 2), notes.length - listRows),
    );
    const list = notes.slice(start, start + listRows);
    const current = notes[this.#index];

    const header = ` ccc-morph notes [${this.#tab}] ${notes.length} `;
    const listLines =
      list.length === 0
        ? ["(no notes)"]
        : list.map((note, offset) => {
            const absolute = start + offset;
            const cursor = absolute === this.#index ? ">" : " ";
            const selected =
              this.#tab === "active" ? (this.#selected.has(note.id) ? "[x]" : "[ ]") : "   ";
            const summary = visible(note.text).split(/\r?\n/, 1)[0] || "(empty)";
            return clip(`${cursor}${selected} ${formatLocal(note.createdAt)} ${summary}`, columns);
          });

    const allPreview = current ? this.#previewLines(current, columns) : [];
    const maxScroll = Math.max(0, allPreview.length - previewRows);
    this.#previewScroll = Math.min(this.#previewScroll, maxScroll);
    const preview = allPreview.slice(this.#previewScroll, this.#previewScroll + previewRows);

    const output = [
      `\x1b[0m\x1b[2J\x1b[H\x1b[7m${clip(header, columns)}\x1b[0m`,
      ...listLines,
      ...Array.from({ length: Math.max(0, listRows - listLines.length) }, () => ""),
      "─".repeat(columns),
      ...preview,
      `\x1b[${rows - 2};1H\x1b[7m${clip(this.#scrollFooter(allPreview.length, previewRows), columns)}\x1b[0m`,
      `\x1b[${rows - 1};1H\x1b[7m${clip(this.#createFooter(), columns)}\x1b[0m`,
      `\x1b[${rows};1H\x1b[7m${clip(this.#manageFooter(), columns)}\x1b[0m`,
    ].join("\r\n");
    process.stdout.write(output);
  }

  #visibleNotes(): WorkspaceNote[] {
    return this.#notes
      .filter((note) =>
        this.#tab === "active" ? note.archivedAt === null : note.archivedAt !== null,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  #current(): WorkspaceNote | undefined {
    return this.#visibleNotes()[this.#index];
  }

  #moveSelection(delta: number): void {
    const notes = this.#visibleNotes();
    this.#index = Math.max(0, Math.min(notes.length - 1, this.#index + delta));
    this.#previewScroll = 0;
    this.#message = "";
    this.render();
  }

  #scrollPreview(delta: number): void {
    const note = this.#current();
    if (!note) return;
    const { columns, previewRows } = this.#layout();
    const maxScroll = Math.max(0, this.#previewLines(note, columns).length - previewRows);
    const next = Math.max(0, Math.min(maxScroll, this.#previewScroll + delta));
    if (next === this.#previewScroll) return;
    this.#previewScroll = next;
    this.#message = "";
    this.render();
  }

  #switchTab(): void {
    this.#tab = this.#tab === "active" ? "archive" : "active";
    this.#index = 0;
    this.#previewScroll = 0;
    this.#confirmDelete = null;
    this.#message = "";
    this.render();
  }

  #toggle(): void {
    if (this.#tab !== "active") return;
    const note = this.#current();
    if (!note) return;
    if (this.#selected.has(note.id)) this.#selected.delete(note.id);
    else this.#selected.add(note.id);
    this.#message = "";
    this.render();
  }

  async #submit(): Promise<void> {
    if (this.#tab !== "active") return;
    const notes = this.#notes
      .filter((note) => note.archivedAt === null && this.#selected.has(note.id))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    if (notes.length === 0) {
      this.#message = "select at least one note with Space";
      this.render();
      return;
    }
    this.#busy = true;
    this.#active = false;
    try {
      await this.#controls.submit(notes);
    } finally {
      this.#busy = false;
    }
  }

  async #edit(): Promise<void> {
    if (!this.#controls.edit) return;
    const note = this.#current();
    if (!note) return;
    this.#busy = true;
    this.#active = false;
    try {
      await this.#controls.edit(note);
    } finally {
      this.#busy = false;
    }
  }

  async #add(): Promise<void> {
    if (!this.#controls.add) return;
    this.#busy = true;
    this.#active = false;
    try {
      await this.#controls.add();
    } finally {
      this.#busy = false;
    }
  }

  async #capture(): Promise<void> {
    if (!this.#controls.capture) return;
    this.#busy = true;
    this.#active = false;
    try {
      await this.#controls.capture();
    } finally {
      this.#busy = false;
    }
  }

  async #history(): Promise<void> {
    if (!this.#controls.history) return;
    this.#busy = true;
    this.#active = false;
    try {
      await this.#controls.history();
    } finally {
      this.#busy = false;
    }
  }

  async #restore(): Promise<void> {
    if (this.#tab !== "archive") return;
    const note = this.#current();
    if (!note) return;
    await this.#runMutation(async () => {
      await this.#store.restore(note.id);
      this.#message = "note restored";
    });
  }

  #askDelete(): void {
    const note = this.#current();
    if (!note) return;
    this.#confirmDelete = note.id;
    this.#message = "delete this note permanently? y/N";
    this.render();
  }

  async #deleteConfirmed(): Promise<void> {
    const id = this.#confirmDelete;
    this.#confirmDelete = null;
    if (id === null) return;
    await this.#runMutation(async () => {
      await this.#store.delete(id);
      this.#selected.delete(id);
      this.#message = "note deleted";
    });
  }

  async #runMutation(operation: () => Promise<void>): Promise<void> {
    this.#busy = true;
    try {
      await operation();
      this.#notes = this.#store.load();
      this.#previewScroll = 0;
      this.#index = Math.max(0, Math.min(this.#index, this.#visibleNotes().length - 1));
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    } finally {
      this.#busy = false;
      this.render();
    }
  }

  // Footer row 1: how to page within the current note.
  #scrollFooter(previewTotal: number, previewRows: number): string {
    const position =
      previewTotal > previewRows
        ? `  ${this.#previewScroll + 1}-${Math.min(this.#previewScroll + previewRows, previewTotal)}/${previewTotal}`
        : "";
    return ` scroll:  j/k line  d/u half  f/b page  g/G ends${position} `;
  }

  // Footer row 2: how to create or change a note.
  #createFooter(): string {
    return " create:  a add  c capture  C history  e edit ";
  }

  // Footer row 3: how to manage the list (or a transient status message).
  #manageFooter(): string {
    if (this.#message) return ` ${this.#message} `;
    return this.#tab === "active"
      ? " manage:  ↑/↓ move  Space mark  Enter insert  D delete  Tab archive  q quit "
      : " manage:  ↑/↓ move  r restore  Tab active  D delete  q quit ";
  }
}
