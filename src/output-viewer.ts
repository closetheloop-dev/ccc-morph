import type { TranscriptMessage } from "./output-capture";
import { ViewerInput, type ViewerInputToken } from "./viewer-input";

type OutputViewerControls = {
  // Called with the chosen response's text; the caller opens the note editor on it.
  select: (text: string) => void | Promise<void>;
  // Called when the browser is dismissed without choosing (returns to the notes hub).
  close: () => void;
};

function visible(value: string): string {
  return (
    value
      // Normalize CRLF to LF first so real line breaks split cleanly and are not left
      // as an escaped \x0d; a remaining bare \r is escaped as a control below.
      .replace(/\r\n/g, "\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal control bytes must not render in the browser
      .replace(/\x1b/g, "\\x1b")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal control bytes must not render in the browser
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

// A list+preview history over the wrapped program's recent responses (and Claude Code plans).
// The caller opens it with a snapshot (newest-first); the user navigates and selects one to
// capture into a note.
export class OutputViewer {
  readonly #controls: OutputViewerControls;
  readonly #input: ViewerInput;
  #active = false;
  #messages: TranscriptMessage[] = [];
  #index = 0;
  #previewScroll = 0;
  #busy = false;

  constructor(controls: OutputViewerControls) {
    this.#controls = controls;
    this.#input = new ViewerInput((token) => this.#handleToken(token));
  }

  get active(): boolean {
    return this.#active;
  }

  open(messages: TranscriptMessage[]): void {
    this.#messages = messages.slice();
    this.#active = true;
    this.#index = 0;
    this.#previewScroll = 0;
    this.#input.reset();
    this.render();
  }

  // Tear down without returning to the hub; used during session cleanup.
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
    // Arrows move between responses to select; everything else scrolls the preview.
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
    if (token === 0x71 || token === 0x1b)
      this.close(); // q / Escape
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
    else if (token === 0x0d || token === 0x0a) void this.#select(); // Enter — capture
  }

  #layout(): { rows: number; columns: number; listRows: number; previewRows: number } {
    const rows = Math.max(process.stdout.rows ?? 24, 8);
    const columns = Math.max(process.stdout.columns ?? 80, 20);
    const listRows = Math.max(3, Math.min(8, Math.floor((rows - 4) / 2)));
    // Reserve two footer rows: scroll help and select/return help.
    const previewRows = Math.max(1, rows - (1 + listRows + 1) - 2);
    return { rows, columns, listRows, previewRows };
  }

  #previewLines(text: string, columns: number): string[] {
    return visible(text)
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
    this.#index = Math.max(0, Math.min(this.#index, Math.max(0, this.#messages.length - 1)));
    const start = Math.max(
      0,
      Math.min(this.#index - Math.floor(listRows / 2), this.#messages.length - listRows),
    );
    const list = this.#messages.slice(start, start + listRows);
    const current = this.#messages[this.#index];

    const header = ` ccc-morph history ${this.#messages.length} `;
    const listLines =
      list.length === 0
        ? ["(no history yet)"]
        : list.map((message, offset) => {
            const absolute = start + offset;
            const cursor = absolute === this.#index ? ">" : " ";
            const first = visible(message.text).split(/\r?\n/, 1)[0] || "(empty)";
            // Plans are labelled in the list; the captured text stays the raw plan body.
            const summary =
              message.kind === "plan" ? `plan: ${first.replace(/^#+\s*/, "")}` : first;
            return clip(`${cursor} ${summary}`, columns);
          });

    const allPreview = current ? this.#previewLines(current.text, columns) : [];
    const maxScroll = Math.max(0, allPreview.length - previewRows);
    this.#previewScroll = Math.min(this.#previewScroll, maxScroll);
    const preview = allPreview.slice(this.#previewScroll, this.#previewScroll + previewRows);

    const output = [
      `\x1b[0m\x1b[2J\x1b[H\x1b[7m${clip(header, columns)}\x1b[0m`,
      ...listLines,
      ...Array.from({ length: Math.max(0, listRows - listLines.length) }, () => ""),
      "─".repeat(columns),
      ...preview,
      `\x1b[${rows - 1};1H\x1b[7m${clip(this.#scrollFooter(allPreview.length, previewRows), columns)}\x1b[0m`,
      `\x1b[${rows};1H\x1b[7m${clip(this.#navFooter(), columns)}\x1b[0m`,
    ].join("\r\n");
    process.stdout.write(output);
  }

  #current(): TranscriptMessage | undefined {
    return this.#messages[this.#index];
  }

  #moveSelection(delta: number): void {
    if (this.#messages.length === 0) return;
    this.#index = Math.max(0, Math.min(this.#messages.length - 1, this.#index + delta));
    this.#previewScroll = 0;
    this.render();
  }

  #scrollPreview(delta: number): void {
    const message = this.#current();
    if (!message) return;
    const { columns, previewRows } = this.#layout();
    const maxScroll = Math.max(0, this.#previewLines(message.text, columns).length - previewRows);
    const next = Math.max(0, Math.min(maxScroll, this.#previewScroll + delta));
    if (next === this.#previewScroll) return;
    this.#previewScroll = next;
    this.render();
  }

  async #select(): Promise<void> {
    const message = this.#current();
    if (!message) return;
    this.#busy = true;
    this.#active = false;
    try {
      await this.#controls.select(message.text);
    } finally {
      this.#busy = false;
    }
  }

  // Footer row 1: how to scroll within the current response.
  #scrollFooter(previewTotal: number, previewRows: number): string {
    const position =
      previewTotal > previewRows
        ? `  ${this.#previewScroll + 1}-${Math.min(this.#previewScroll + previewRows, previewTotal)}/${previewTotal}`
        : "";
    return ` scroll:  j/k line  d/u half  f/b page  g/G ends${position} `;
  }

  // Footer row 2: how to pick a response or leave.
  #navFooter(): string {
    if (this.#messages.length === 0) return " q/Esc return ";
    return " select:  ↑/↓ move  Enter capture  q/Esc return ";
  }
}
