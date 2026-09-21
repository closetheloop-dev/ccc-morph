import type { ChordElement } from "./keys";

export type SendAction = {
  type: "send";
  keys?: string[];
  text?: string;
  bytes?: string;
};

export type RunAction = {
  type: "run";
  argv: string[];
};

export type ShowErrorsAction = { type: "show-errors" };
export type QuitAction = { type: "quit" };
export type IgnoreAction = { type: "ignore" };
export type AddNoteAction = {
  type: "add-note";
  // "output" pre-fills the note editor with the wrapped program's recent output.
  source?: "editor" | "output";
};
export type ShowNotesAction = { type: "show-notes" };

export type Action =
  | SendAction
  | RunAction
  | ShowErrorsAction
  | QuitAction
  | IgnoreAction
  | AddNoteAction
  | ShowNotesAction;

export type NotesChildMode = "pause" | "continue";

export type Binding = {
  keys: string[];
  action: Action;
};

// The global configuration file (config.toml): applies to every wrapped program.
export type SessionConfig = {
  version: 1;
  sequenceTimeoutMs: number;
  maxErrorOutputBytes: number;
  noticeTimeoutMs: number;
  completionNoticeTimeoutMs: number;
  startNoticeTimeoutMs: number;
  notesChildMode: NotesChildMode;
  bindings: Binding[];
};

// A per-app configuration file (apps/<name>.toml): overrides layered on top of
// the globals when the wrapped program's basename (or an alias) matches.
export type AppConfig = {
  version: 1;
  sequenceTimeoutMs?: number;
  maxErrorOutputBytes?: number;
  noticeTimeoutMs?: number;
  completionNoticeTimeoutMs?: number;
  startNoticeTimeoutMs?: number;
  notesChildMode?: NotesChildMode;
  inheritGlobals: boolean;
  unbind: string[][];
  bindings: Binding[];
  aliases: string[];
};

export type ResolvedConfig = SessionConfig & {
  appName: string | null;
};

export type CompiledBinding = Binding & {
  id: string;
  label: string;
  // The compiled chord: one element per keystroke, each an accept-set of key ids or
  // an exact byte sequence. This is the single identity the matcher, duplicate
  // detection, merging, and unbinding all use, so a binding fires whether the
  // terminal sent legacy bytes or Kitty CSI-u for those keys.
  chord: readonly ChordElement[];
};

export type ActionError = {
  binding: string;
  argv: string[];
  occurredAt: Date;
  exitCode: number | null;
  signal: string | null;
  message: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};
