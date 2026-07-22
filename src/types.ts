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

export type Action = SendAction | RunAction | ShowErrorsAction | QuitAction | IgnoreAction;

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
  pattern: Uint8Array;
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
