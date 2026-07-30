import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { defaultConfigDirectory } from "./config";

const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 25;
const STALE_LOCK_MS = 30_000;
const MAX_READABLE_PREFIX = 180;

export type WorkspaceNote = {
  id: string;
  text: string;
  createdAt: string;
  archivedAt: string | null;
};

type WorkspaceHeader = {
  type: "workspace";
  version: 1;
  path: string;
};

type NoteLine = WorkspaceNote & { type: "note" };

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function readablePath(path: string): string {
  const flattened = path
    .replace(/^\/+/, "")
    .replaceAll("/", "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (flattened || basename(path) || "workspace").slice(0, MAX_READABLE_PREFIX);
}

export function workspaceNotesFilename(workspace: string): string {
  const canonical = canonicalPath(workspace);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
  return `${readablePath(canonical)}-${hash}.jsonl`;
}

function noteLine(value: unknown, context: string): WorkspaceNote {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.type !== "note" ||
    typeof raw.id !== "string" ||
    raw.id.length === 0 ||
    typeof raw.text !== "string" ||
    typeof raw.createdAt !== "string" ||
    (raw.archivedAt !== null && typeof raw.archivedAt !== "string")
  ) {
    throw new Error(`${context} is not a valid note record`);
  }
  return {
    id: raw.id,
    text: raw.text,
    createdAt: raw.createdAt,
    archivedAt: raw.archivedAt,
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

export class NoteStore {
  readonly #workspace: string;
  readonly #directory: string;
  readonly #path: string;
  readonly #lockPath: string;

  constructor(workspace = process.cwd(), directory = `${defaultConfigDirectory()}/notes`) {
    this.#workspace = canonicalPath(workspace);
    this.#directory = directory;
    this.#path = `${directory}/${workspaceNotesFilename(this.#workspace)}`;
    this.#lockPath = `${this.#path}.lock`;
  }

  get path(): string {
    return this.#path;
  }

  load(): WorkspaceNote[] {
    if (!existsSync(this.#path)) return [];
    const lines = readFileSync(this.#path, "utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.length === 0) throw new Error(`${this.#path}: empty notes file`);

    let header: unknown;
    try {
      header = JSON.parse(lines[0]!);
    } catch (error) {
      throw new Error(`${this.#path}: invalid workspace header: ${String(error)}`);
    }
    const rawHeader = header as Partial<WorkspaceHeader>;
    if (rawHeader.type !== "workspace" || rawHeader.version !== 1) {
      throw new Error(`${this.#path}: unsupported workspace header`);
    }
    if (rawHeader.path !== this.#workspace) {
      throw new Error(
        `${this.#path}: belongs to ${JSON.stringify(rawHeader.path)}, not ${JSON.stringify(this.#workspace)}`,
      );
    }

    const notes: WorkspaceNote[] = [];
    const ids = new Set<string>();
    for (let index = 1; index < lines.length; index += 1) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[index]!);
      } catch (error) {
        throw new Error(`${this.#path}:${index + 1}: invalid JSON: ${String(error)}`);
      }
      const note = noteLine(parsed, `${this.#path}:${index + 1}`);
      if (ids.has(note.id)) throw new Error(`${this.#path}:${index + 1}: duplicate note id`);
      ids.add(note.id);
      notes.push(note);
    }
    return notes;
  }

  async add(text: string): Promise<WorkspaceNote> {
    const note: WorkspaceNote = {
      id: randomUUID(),
      text,
      createdAt: new Date().toISOString(),
      archivedAt: null,
    };
    await this.#mutate((notes) => [...notes, note]);
    return note;
  }

  async update(id: string, text: string): Promise<void> {
    await this.#mutate((notes) => notes.map((note) => (note.id === id ? { ...note, text } : note)));
  }

  async archive(ids: readonly string[]): Promise<void> {
    const selected = new Set(ids);
    const archivedAt = new Date().toISOString();
    await this.#mutate((notes) =>
      notes.map((note) => (selected.has(note.id) ? { ...note, archivedAt } : note)),
    );
  }

  async restore(id: string): Promise<void> {
    await this.#mutate((notes) =>
      notes.map((note) => (note.id === id ? { ...note, archivedAt: null } : note)),
    );
  }

  async delete(id: string): Promise<void> {
    await this.#mutate((notes) => notes.filter((note) => note.id !== id));
  }

  async #mutate(update: (notes: WorkspaceNote[]) => WorkspaceNote[]): Promise<void> {
    await this.#withLock(async () => {
      const notes = this.load();
      this.#write(update(notes));
    });
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.#directory, 0o700);
    } catch {
      // Best effort when the directory already exists on an unusual filesystem.
    }

    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        mkdirSync(this.#lockPath, { mode: 0o700 });
        try {
          writeFileSync(
            `${this.#lockPath}/owner.json`,
            `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`,
            { mode: 0o600 },
          );
        } catch (error) {
          rmSync(this.#lockPath, { recursive: true, force: true });
          throw error;
        }
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        this.#removeStaleLock();
        if (Date.now() >= deadline)
          throw new Error(`timed out waiting for notes lock: ${this.#path}`);
        await Bun.sleep(LOCK_RETRY_MS);
      }
    }

    try {
      return await operation();
    } finally {
      rmSync(this.#lockPath, { recursive: true, force: true });
    }
  }

  #removeStaleLock(): void {
    try {
      const owner = JSON.parse(readFileSync(`${this.#lockPath}/owner.json`, "utf8")) as {
        pid?: unknown;
        createdAt?: unknown;
      };
      const pid = typeof owner.pid === "number" ? owner.pid : null;
      const createdAt = typeof owner.createdAt === "number" ? owner.createdAt : 0;
      if (Date.now() - createdAt > STALE_LOCK_MS && (pid === null || !processAlive(pid))) {
        rmSync(this.#lockPath, { recursive: true, force: true });
      }
    } catch {
      try {
        if (Date.now() - statSync(this.#lockPath).mtimeMs > STALE_LOCK_MS) {
          rmSync(this.#lockPath, { recursive: true, force: true });
        }
      } catch {
        // The lock disappeared between checks.
      }
    }
  }

  #write(notes: WorkspaceNote[]): void {
    const header: WorkspaceHeader = { type: "workspace", version: 1, path: this.#workspace };
    const lines = [
      JSON.stringify(header),
      ...notes.map((note): string => JSON.stringify({ type: "note", ...note } satisfies NoteLine)),
      "",
    ].join("\n");
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const descriptor = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(descriptor, lines, "utf8");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporary, this.#path);
      chmodSync(this.#path, 0o600);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
