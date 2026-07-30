import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { bytesKey, encodeKeys, encodeRawHex } from "./keys";
import type {
  Action,
  AppConfig,
  Binding,
  CompiledBinding,
  NotesChildMode,
  ResolvedConfig,
  SessionConfig,
} from "./types";

const DEFAULT_SEQUENCE_TIMEOUT_MS = 1000;
const DEFAULT_MAX_ERROR_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_NOTICE_TIMEOUT_MS = 10_000;
const DEFAULT_COMPLETION_NOTICE_TIMEOUT_MS = 5_000;
const DEFAULT_START_NOTICE_TIMEOUT_MS = 3_000;
const DEFAULT_NOTES_CHILD_MODE: NotesChildMode = "pause";

function object(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be a table`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, fallback: number, context: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${context} must be a positive integer`);
  }
  return value as number;
}

function optionalPositiveInteger(value: unknown, context: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${context} must be a positive integer`);
  }
  return value as number;
}

function optionalNotesChildMode(value: unknown, context: string): NotesChildMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "pause" && value !== "continue") {
    throw new Error(`${context} must be "pause" or "continue"`);
  }
  return value;
}

function stringArray(value: unknown, context: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error(`${context} must be a non-empty array of strings`);
  }
  return value as string[];
}

function optionalStringArray(value: unknown, context: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error(`${context} must be an array of non-empty strings`);
  }
  return value as string[];
}

function parseAction(value: unknown, context: string): Action {
  const raw = object(value, context);
  const type = raw.type;
  if (type === "show-errors" || type === "quit" || type === "ignore" || type === "show-notes") {
    return { type };
  }

  if (type === "add-note") {
    return { type };
  }

  if (type === "run") {
    const argv = stringArray(raw.argv, `${context}.argv`);
    return { type, argv };
  }

  if (type === "send") {
    const sources = [
      raw.keys !== undefined,
      raw.text !== undefined,
      raw.bytes !== undefined,
    ].filter(Boolean).length;
    if (sources !== 1) {
      throw new Error(`${context} must define exactly one of keys, text, or bytes`);
    }
    if (raw.keys !== undefined) {
      const keys = stringArray(raw.keys, `${context}.keys`);
      encodeKeys(keys);
      return { type, keys };
    }
    if (raw.text !== undefined) {
      if (typeof raw.text !== "string") throw new Error(`${context}.text must be a string`);
      return { type, text: raw.text };
    }
    if (typeof raw.bytes !== "string")
      throw new Error(`${context}.bytes must be a hexadecimal string`);
    encodeRawHex(raw.bytes);
    return { type, bytes: raw.bytes };
  }

  throw new Error(
    `${context}.type must be send, run, show-errors, quit, ignore, add-note, or show-notes`,
  );
}

function parseBindings(value: unknown, context: string): Binding[] {
  const entries = value ?? [];
  if (!Array.isArray(entries)) throw new Error(`${context} must be an array of tables`);
  const bindings = entries.map((entry, index) => {
    const item = object(entry, `${context}[${index}]`);
    return {
      keys: stringArray(item.keys, `${context}[${index}].keys`),
      action: parseAction(item.action, `${context}[${index}].action`),
    };
  });
  assertUniqueBindings(bindings, context);
  return bindings;
}

function parseUnbind(value: unknown, context: string): string[][] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${context} must be an array of tables`);
  return value.map((entry, index) => {
    const item = object(entry, `${context}[${index}]`);
    const keys = stringArray(item.keys, `${context}[${index}].keys`);
    encodeKeys(keys);
    return keys;
  });
}

function validateProgramName(value: string, context: string): void {
  if (value.length === 0 || value === "." || value === ".." || value.includes("/")) {
    throw new Error(`${context} must be a non-empty executable basename without /`);
  }
}

function bindingKey(binding: Binding): string {
  return bytesKey(encodeKeys(binding.keys));
}

function assertUniqueBindings(bindings: Binding[], context: string): void {
  const seen = new Map<string, string>();
  for (const binding of bindings) {
    const encoded = bindingKey(binding);
    const label = binding.keys.join(" ");
    const previous = seen.get(encoded);
    if (previous !== undefined) {
      throw new Error(
        `${context} binding ${JSON.stringify(label)} has the same terminal encoding as ${JSON.stringify(previous)}`,
      );
    }
    seen.set(encoded, label);
  }
}

export function parseConfigText(text: string, source = "configuration"): SessionConfig {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (error) {
    throw new Error(`${source}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const raw = object(parsed, source);
  if (raw.version !== 1) throw new Error(`${source}.version must be 1`);

  return {
    version: 1,
    sequenceTimeoutMs: positiveInteger(
      raw.sequence_timeout_ms,
      DEFAULT_SEQUENCE_TIMEOUT_MS,
      `${source}.sequence_timeout_ms`,
    ),
    maxErrorOutputBytes: positiveInteger(
      raw.max_error_output_bytes,
      DEFAULT_MAX_ERROR_OUTPUT_BYTES,
      `${source}.max_error_output_bytes`,
    ),
    noticeTimeoutMs: positiveInteger(
      raw.notice_timeout_ms,
      DEFAULT_NOTICE_TIMEOUT_MS,
      `${source}.notice_timeout_ms`,
    ),
    completionNoticeTimeoutMs: positiveInteger(
      raw.completion_notice_timeout_ms,
      DEFAULT_COMPLETION_NOTICE_TIMEOUT_MS,
      `${source}.completion_notice_timeout_ms`,
    ),
    startNoticeTimeoutMs: positiveInteger(
      raw.start_notice_timeout_ms,
      DEFAULT_START_NOTICE_TIMEOUT_MS,
      `${source}.start_notice_timeout_ms`,
    ),
    notesChildMode:
      optionalNotesChildMode(raw.notes_child_mode, `${source}.notes_child_mode`) ??
      DEFAULT_NOTES_CHILD_MODE,
    bindings: parseBindings(raw.bindings, `${source}.bindings`),
  };
}

export function parseAppConfigText(text: string, source = "app config"): AppConfig {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (error) {
    throw new Error(`${source}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const raw = object(parsed, source);
  if (raw.version !== 1) throw new Error(`${source}.version must be 1`);
  const inheritGlobals = raw.inherit_globals === undefined ? true : raw.inherit_globals;
  if (typeof inheritGlobals !== "boolean") {
    throw new Error(`${source}.inherit_globals must be a boolean`);
  }
  const unbind = parseUnbind(raw.unbind, `${source}.unbind`);
  if (!inheritGlobals && unbind.length > 0) {
    throw new Error(`${source}.unbind cannot be used when inherit_globals is false`);
  }
  const aliases = optionalStringArray(raw.aliases, `${source}.aliases`);
  for (const [index, alias] of aliases.entries()) {
    validateProgramName(alias, `${source}.aliases[${index}]`);
  }

  return {
    version: 1,
    sequenceTimeoutMs: optionalPositiveInteger(
      raw.sequence_timeout_ms,
      `${source}.sequence_timeout_ms`,
    ),
    maxErrorOutputBytes: optionalPositiveInteger(
      raw.max_error_output_bytes,
      `${source}.max_error_output_bytes`,
    ),
    noticeTimeoutMs: optionalPositiveInteger(raw.notice_timeout_ms, `${source}.notice_timeout_ms`),
    completionNoticeTimeoutMs: optionalPositiveInteger(
      raw.completion_notice_timeout_ms,
      `${source}.completion_notice_timeout_ms`,
    ),
    startNoticeTimeoutMs: optionalPositiveInteger(
      raw.start_notice_timeout_ms,
      `${source}.start_notice_timeout_ms`,
    ),
    notesChildMode: optionalNotesChildMode(raw.notes_child_mode, `${source}.notes_child_mode`),
    inheritGlobals,
    unbind,
    bindings: parseBindings(raw.bindings, `${source}.bindings`),
    aliases,
  };
}

export function emptyConfig(): SessionConfig {
  return {
    version: 1,
    sequenceTimeoutMs: DEFAULT_SEQUENCE_TIMEOUT_MS,
    maxErrorOutputBytes: DEFAULT_MAX_ERROR_OUTPUT_BYTES,
    noticeTimeoutMs: DEFAULT_NOTICE_TIMEOUT_MS,
    completionNoticeTimeoutMs: DEFAULT_COMPLETION_NOTICE_TIMEOUT_MS,
    startNoticeTimeoutMs: DEFAULT_START_NOTICE_TIMEOUT_MS,
    notesChildMode: DEFAULT_NOTES_CHILD_MODE,
    bindings: [],
  };
}

function resolveGlobals(config: SessionConfig): ResolvedConfig {
  return {
    version: 1,
    sequenceTimeoutMs: config.sequenceTimeoutMs,
    maxErrorOutputBytes: config.maxErrorOutputBytes,
    noticeTimeoutMs: config.noticeTimeoutMs,
    completionNoticeTimeoutMs: config.completionNoticeTimeoutMs,
    startNoticeTimeoutMs: config.startNoticeTimeoutMs,
    notesChildMode: config.notesChildMode,
    bindings: [...config.bindings],
    appName: null,
  };
}

export function applyAppConfig(
  config: ResolvedConfig,
  app: AppConfig,
  appName: string,
): ResolvedConfig {
  const merged = new Map<string, Binding>();
  if (app.inheritGlobals) {
    for (const binding of config.bindings) merged.set(bindingKey(binding), binding);
  }
  for (const keys of app.unbind) merged.delete(bytesKey(encodeKeys(keys)));
  for (const binding of app.bindings) merged.set(bindingKey(binding), binding);

  return {
    version: 1,
    sequenceTimeoutMs: app.sequenceTimeoutMs ?? config.sequenceTimeoutMs,
    maxErrorOutputBytes: app.maxErrorOutputBytes ?? config.maxErrorOutputBytes,
    noticeTimeoutMs: app.noticeTimeoutMs ?? config.noticeTimeoutMs,
    completionNoticeTimeoutMs: app.completionNoticeTimeoutMs ?? config.completionNoticeTimeoutMs,
    startNoticeTimeoutMs: app.startNoticeTimeoutMs ?? config.startNoticeTimeoutMs,
    notesChildMode: app.notesChildMode ?? config.notesChildMode,
    bindings: Array.from(merged.values()),
    appName,
  };
}

// Resolve a program name to the name of the app-config file that governs it:
// a direct apps/<program>.toml, else the app config whose `aliases` include the
// program. Returns null when nothing matches. Unparseable files are skipped
// during the alias scan so one bad file doesn't break discovery for others.
function discoverAppConfig(appsDir: string, program: string): string | null {
  if (existsSync(join(appsDir, `${program}.toml`))) return program;
  if (!existsSync(appsDir)) return null;

  const matches: string[] = [];
  for (const file of readdirSync(appsDir)) {
    if (!file.endsWith(".toml")) continue;
    const filePath = join(appsDir, file);
    let app: AppConfig;
    try {
      app = parseAppConfigText(readFileSync(filePath, "utf8"), filePath);
    } catch {
      continue;
    }
    if (app.aliases.includes(program)) matches.push(file.slice(0, -".toml".length));
  }
  if (matches.length > 1) {
    throw new Error(
      `program ${JSON.stringify(program)} matches multiple app configs: ${matches.join(", ")}`,
    );
  }
  return matches[0] ?? null;
}

export function compileBindings(config: SessionConfig): CompiledBinding[] {
  assertUniqueBindings(config.bindings, "resolved configuration");
  return config.bindings.map((binding, index) => ({
    ...binding,
    id: `binding-${index}`,
    label: binding.keys.join(" "),
    pattern: encodeKeys(binding.keys),
  }));
}

export function defaultConfigDirectory(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), ".config"), "ccc-morph");
}

export function defaultConfigPath(): string {
  return join(defaultConfigDirectory(), "config.toml");
}

export function loadConfig(path: string | null, explicit: boolean): SessionConfig {
  if (path === null) return emptyConfig();
  if (!existsSync(path)) {
    if (explicit) throw new Error(`configuration file does not exist: ${path}`);
    return emptyConfig();
  }
  return parseConfigText(readFileSync(path, "utf8"), path);
}

export function loadResolvedConfig(
  path: string | null,
  explicit: boolean,
  command: string[],
  requestedApp: string | null,
): ResolvedConfig {
  const globals = resolveGlobals(loadConfig(path, explicit));

  // --no-config (path null) and --config FILE (explicit) both use globals only,
  // with no per-app discovery. --app is rejected alongside these at parse time.
  if (path === null || explicit) return globals;

  const appsDir = join(dirname(path), "apps");

  let appName: string | null;
  if (requestedApp !== null) {
    validateProgramName(requestedApp, "app name");
    appName = discoverAppConfig(appsDir, requestedApp);
    if (appName === null) throw new Error(`unknown app config: ${requestedApp}`);
  } else {
    const program = basename(command[0] ?? "");
    const safeProgram = program.length > 0 && program !== "." && program !== ".." ? program : null;
    appName = safeProgram === null ? null : discoverAppConfig(appsDir, safeProgram);
  }

  if (appName === null) return globals;
  const appPath = join(appsDir, `${appName}.toml`);
  const app = parseAppConfigText(readFileSync(appPath, "utf8"), appPath);
  return applyAppConfig(globals, app, appName);
}
