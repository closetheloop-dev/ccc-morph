import { Database } from "bun:sqlite";
import {
  closeSync,
  type Dirent,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { detectClaudeResume, detectCodexResume, type ResumeIntent } from "./resume";

export const DEFAULT_CAPTURE_BYTES = 256 * 1024;

// Upper bound on how much of a transcript we read on demand: only the last this-many bytes
// (a whole-line tail) are loaded, so a long-lived session cannot block the terminal or blow
// up memory when `c`/`C` is pressed. Also bounds how many records/plans history can retain.
export const DEFAULT_TRANSCRIPT_READ_BYTES = 8 * 1024 * 1024;

type CaptureOptions = {
  // Resolved app identity (e.g. "codex", "claude"); selects a JSONL adapter.
  commandName: string;
  cwd: string;
  // True when the wrapped command resumes the most-recent session (`claude --continue`,
  // `codex resume --last`); only then may capture fall back to the newest transcript that
  // predates launch. False for the interactive picker, whose chosen session is unknown up
  // front -- guessing the newest could surface a different conversation than the one picked.
  resumeLatest?: boolean;
  // The explicit session id from a resume selector (`--resume <id>` / `resume <id>`), if any.
  // When set, the pre-launch fallback must match this session rather than pick the newest.
  resumeSessionId?: string | null;
  capBytes?: number;
  // Max bytes read from the tail of a transcript on each capture (overridable in tests).
  readCapBytes?: number;
  // Home directory for locating transcripts; defaults to the OS home (overridable in tests).
  home?: string;
  // Test seam: the recursive transcript/rollout collector, defaulting to the real filesystem
  // walk. Tests inject a counting stub to assert that an indexed Codex resume performs no scan.
  collect?: (
    dir: string,
    match: (name: string) => boolean,
    depth: number,
  ) => { path: string; mtimeMs: number }[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function capTail(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(text.length - cap);
}

// Remove terminal escape sequences so the raw PTY buffer reads as plain text. Best
// effort: covers CSI (colors/cursor), OSC (titles), and other single/paired escapes.
export function stripAnsi(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC ends at BEL or ST
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: DCS/SOS/PM/APC end at ST
      .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: CSI parameter+final bytes
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: remaining two-byte escapes
      .replace(/\x1b[@-Z\\-_]/g, "")
  );
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record && record.type === "text" && typeof record.text === "string") {
      out.push(record.text);
    }
  }
  return out.join("\n");
}

// Claude Code writes one JSON object per line. Return only the agent's most recent
// message (the last non-empty assistant turn); "" when there is no assistant turn yet
// so callers fall back to the raw buffer.
export function extractClaudeLatestMessage(jsonlText: string, cap: number): string {
  let latest = "";
  for (const line of jsonlText.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const object = asRecord(parsed);
    if (!object) continue;
    if (object.type !== "assistant") continue;
    const text = textFromContent(asRecord(object.message)?.content).trim();
    if (text.length > 0) latest = text;
  }
  return capTail(latest, cap);
}

// Codex rollout files wrap message items in an envelope; tolerate a few shapes. Return
// only the agent's most recent message (the last non-empty assistant message).
export function extractCodexLatestMessage(jsonlText: string, cap: number): string {
  let latest = "";
  for (const line of jsonlText.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const outer = asRecord(parsed);
    if (!outer) continue;
    const item = asRecord(outer.payload) ?? asRecord(outer.item) ?? outer;
    if (item.type !== "message") continue;
    if ((typeof item.role === "string" ? item.role : "assistant") !== "assistant") continue;
    const content = item.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      const out: string[] = [];
      for (const block of content) {
        const record = asRecord(block);
        if (record && typeof record.text === "string") out.push(record.text);
      }
      text = out.join("\n");
    }
    text = text.trim();
    if (text.length > 0) latest = text;
  }
  return capTail(latest, cap);
}

// One past turn for the notes response history: the wrapped CLI's turn is tagged role
// "agent" (not "assistant"), matching how the CLIs are named elsewhere; the human turn
// is "user". `kind:"plan"` marks a plan -- a Claude Code ExitPlanMode document or a Codex
// Plan Mode <proposed_plan> block -- so the list can label it; the text stays the raw plan body.
export type TranscriptMessage = { role: "user" | "agent"; text: string; kind?: "plan" };

// True when `filePath` is a Claude plan file, i.e. a `.claude/plans/` directory. Matches
// `.claude` and `plans` as whole `/`-separated path components (Claude writes POSIX paths),
// so a near-miss like `/workspace/not.claude/plans/result.md` is not treated as a plan.
function isClaudePlanPath(filePath: string): boolean {
  const segments = filePath.split("/");
  for (let index = 0; index + 1 < segments.length; index += 1) {
    if (segments[index] === ".claude" && segments[index + 1] === "plans") return true;
  }
  return false;
}

// A Claude Code plan appears in the transcript in one of two shapes, depending on the
// Claude version: older builds emit an `ExitPlanMode` tool call carrying the plan in
// `input.plan`; newer builds write the plan markdown to `~/.claude/plans/<slug>.md` via
// the `Write` tool, so the plan is that file's `input.content`. Return the plan text
// (trimmed) for either, else null. Claude overwrites the plan file across calls, so the
// transcript is the only place earlier plans survive.
function claudePlan(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type !== "tool_use") continue;
    if (record.name === "ExitPlanMode") {
      const plan = asRecord(record.input)?.plan;
      if (typeof plan === "string" && plan.trim().length > 0) return plan.trim();
    }
    if (record.name === "Write") {
      const input = asRecord(record.input);
      const filePath = input?.file_path;
      const planText = input?.content;
      if (
        typeof filePath === "string" &&
        isClaudePlanPath(filePath) &&
        typeof planText === "string" &&
        planText.trim().length > 0
      ) {
        return planText.trim();
      }
    }
  }
  return null;
}

// Claude Code tags slash-command bookkeeping and meta records so they can be dropped from
// the browsable history; a genuine typed prompt carries none of these markers.
const LOCAL_COMMAND_TAG =
  /^<(command-name|command-message|command-args|local-command-stdout|local-command-caveat)\b/;

function isSyntheticClaudeUser(record: Record<string, unknown>, text: string): boolean {
  return record.isMeta === true || LOCAL_COMMAND_TAG.test(text.trimStart());
}

// The last `n` non-empty Claude turns (oldest-first, both roles interleaved), each capped,
// for the notes response history. A `type:"assistant"` line becomes role "agent" and also
// yields a `kind:"plan"` item when it carries an ExitPlanMode plan; a `type:"user"` stays
// "user". tool_result "user" lines flatten to "" via textFromContent and drop out on the
// non-empty guard; slash-command bookkeeping is skipped. n<=0 returns every turn found.
export function extractClaudeMessages(
  jsonlText: string,
  cap: number,
  n: number,
): TranscriptMessage[] {
  const all: TranscriptMessage[] = [];
  // Newer Claude emits the same plan twice in one turn -- an ExitPlanMode call AND a
  // plan-file Write with identical content -- so collapse a plan identical to the last one
  // we emitted. This dedup is scoped to a single turn: a real user prompt (below) resets it,
  // so the same plan intentionally re-proposed in a later turn is kept in history.
  let lastPlan: string | null = null;
  for (const line of jsonlText.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const object = asRecord(parsed);
    if (object?.type !== "assistant" && object?.type !== "user") continue;
    const content = asRecord(object.message)?.content;
    const text = textFromContent(content).trim();
    if (object.type === "assistant") {
      if (text.length > 0) all.push({ role: "agent", text: capTail(text, cap) });
      const plan = claudePlan(content);
      if (plan !== null && plan !== lastPlan) {
        all.push({ role: "agent", text: capTail(plan, cap), kind: "plan" });
        lastPlan = plan;
      }
      continue;
    }
    if (isSyntheticClaudeUser(object, text)) continue;
    if (text.length > 0) {
      all.push({ role: "user", text: capTail(text, cap) });
      // A genuine user prompt starts a new turn, so an identical plan proposed after it is
      // a distinct emission, not Claude's paired ExitPlanMode+Write of the same plan.
      lastPlan = null;
    }
  }
  return n > 0 ? all.slice(-n) : all;
}

// Codex Plan Mode wraps its finalized plan in a <proposed_plan> block (opening/closing tags
// on their own lines, Markdown inside). Return the trimmed inner content of each block found;
// [] when there is none. A revision is a complete replacement, so distinct blocks across turns
// are distinct plans.
function proposedPlans(text: string): string[] {
  const plans: string[] = [];
  for (const match of text.matchAll(/<proposed_plan>([\s\S]*?)<\/proposed_plan>/g)) {
    const plan = (match[1] ?? "").trim();
    if (plan.length > 0) plans.push(plan);
  }
  return plans;
}

// The Codex equivalent: the last `n` non-empty turns (both roles interleaved), oldest-first.
// Mirrors extractCodexLatestMessage's envelope tolerance; a Codex "assistant" role maps to
// "agent". A Plan Mode <proposed_plan> block additionally yields a `kind:"plan"` item. Codex's
// injected instruction messages (developer/system: Plan Mode prompts, permissions, etc.) are
// skipped -- they are not conversation turns. n<=0 returns every turn found.
export function extractCodexMessages(
  jsonlText: string,
  cap: number,
  n: number,
): TranscriptMessage[] {
  const all: TranscriptMessage[] = [];
  for (const line of jsonlText.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const outer = asRecord(parsed);
    if (!outer) continue;
    const item = asRecord(outer.payload) ?? asRecord(outer.item) ?? outer;
    if (item.type !== "message") continue;
    const role = item.role;
    if (role === "developer" || role === "system") continue;
    const content = item.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      const out: string[] = [];
      for (const block of content) {
        const record = asRecord(block);
        if (record && typeof record.text === "string") out.push(record.text);
      }
      text = out.join("\n");
    }
    text = text.trim();
    if (text.length === 0) continue;
    const mapped: "user" | "agent" = role === "user" ? "user" : "agent";
    if (mapped === "agent" && text.includes("<proposed_plan>")) {
      // Split a Plan Mode turn into any surrounding response text plus its plan block(s).
      const remainder = text.replace(/<proposed_plan>[\s\S]*?<\/proposed_plan>/g, "").trim();
      if (remainder.length > 0) all.push({ role: "agent", text: capTail(remainder, cap) });
      for (const plan of proposedPlans(text)) {
        all.push({ role: "agent", text: capTail(plan, cap), kind: "plan" });
      }
      continue;
    }
    all.push({ role: mapped, text: capTail(text, cap) });
  }
  return n > 0 ? all.slice(-n) : all;
}

// Read at most the last `maxBytes` of a file, dropping a leading partial line so the
// result is whole JSONL lines. Bounds I/O and memory for large transcripts; the tail is
// exactly what we want (newest turns).
function readTail(path: string, maxBytes: number): string {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const length = size - start;
    if (length <= 0) return "";
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    const text = buffer.toString("utf8", 0, read);
    if (start === 0) return text;
    const newline = text.indexOf("\n");
    return newline === -1 ? "" : text.slice(newline + 1);
  } finally {
    closeSync(fd);
  }
}

// Collect matching files anywhere under `dir` (bounded depth). Codex partitions its
// session rollouts as sessions/YYYY/MM/DD/rollout-*.jsonl, so the search must recurse.
function collectFiles(
  dir: string,
  match: (name: string) => boolean,
  maxDepth: number,
  out: { path: string; mtimeMs: number }[] = [],
  depth = 0,
): { path: string; mtimeMs: number }[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < maxDepth) collectFiles(path, match, maxDepth, out, depth + 1);
    } else if (match(entry.name)) {
      try {
        out.push({ path, mtimeMs: statSync(path).mtimeMs });
      } catch {
        // Vanished between readdir and stat; skip it.
      }
    }
  }
  return out;
}

// Read just the first line of a (potentially large) file without loading the rest.
function firstLine(path: string, maxBytes = 128 * 1024): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const read = readSync(fd, buffer, 0, maxBytes, 0);
    const text = buffer.toString("utf8", 0, read);
    const newline = text.indexOf("\n");
    return newline === -1 ? text : text.slice(0, newline);
  } finally {
    closeSync(fd);
  }
}

// A Codex rollout's first line is a `session_meta` record whose payload carries the
// working directory the session ran in. Used to match the rollout to our own cwd.
function codexRolloutCwd(path: string): string | null {
  try {
    const object = asRecord(JSON.parse(firstLine(path)));
    if (!object) return null;
    if (object.type !== "session_meta") return null;
    const cwd = asRecord(object.payload)?.cwd;
    return typeof cwd === "string" ? cwd : null;
  } catch {
    return null;
  }
}

// The rollout's exact session identifier from its `session_meta` (either `session_id` or
// `id`). Used to match an explicit `resume <id>` to the right rollout -- an exact compare,
// not a filename substring, so a short/partial id cannot select a different session.
function codexRolloutSessionId(path: string): string | null {
  try {
    const object = asRecord(JSON.parse(firstLine(path)));
    if (object?.type !== "session_meta") return null;
    const payload = asRecord(object.payload);
    const id = payload?.session_id ?? payload?.id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

// $CODEX_HOME (or ~/.codex): the root under which Codex keeps `sessions/` and its `state_N.sqlite`
// thread index. Centralized so the transcript scan and the index lookup can never diverge.
function codexHome(home: string): string {
  return process.env.CODEX_HOME && process.env.CODEX_HOME.length > 0
    ? process.env.CODEX_HOME
    : join(home, ".codex");
}

function isCodexRolloutFile(name: string): boolean {
  return name.startsWith("rollout-") && name.endsWith(".jsonl");
}

// A row from Codex's internal thread index (`state_5.sqlite` / `threads`). It is used only to
// resolve a deterministic resume target (`resume <id>` / `resume --last`) with one indexed query
// instead of recursively scanning the whole sessions tree. The SQLite layout is an internal Codex
// detail, NOT a stable API, so every use is guarded: a missing, busy, corrupt, stale, or
// schema-mismatched database silently returns null and the caller falls back to the JSONL scan.
type IndexedCodexThread = { id: string; rolloutPath: string };

// Open Codex's `state_5.sqlite` read-only, or null. Refuses to open if it is absent, or if a
// higher-numbered `state_<N>.sqlite` exists (the version-5 layout we understand may be stale);
// WAL/SHM sidecars are ignored. Never creates, migrates, checkpoints, or writes to the database.
function openCodexIndex(home: string): Database | null {
  const dir = codexHome(home);
  const dbPath = join(dir, "state_5.sqlite");
  try {
    if (!existsSync(dbPath)) return null;
    for (const name of readdirSync(dir)) {
      const match = /^state_(\d+)\.sqlite$/.exec(name);
      if (match && Number(match[1]) > 5) return null;
    }
    return new Database(dbPath, { readonly: true, create: false, strict: true });
  } catch {
    return null;
  }
}

// Run one prepared lookup against the thread index and return {id, rolloutPath} for the first row,
// or null on any error / missing column / bad types. The handle is always closed.
function queryCodexIndex(
  home: string,
  sql: string,
  params: Record<string, string>,
): IndexedCodexThread | null {
  const db = openCodexIndex(home);
  if (db === null) return null;
  try {
    const row = db.query(sql).get(params) as { id?: unknown; rollout_path?: unknown } | null;
    if (row === null) return null;
    const { id, rollout_path: rolloutPath } = row;
    if (typeof id !== "string" || id.length === 0) return null;
    if (typeof rolloutPath !== "string" || rolloutPath.length === 0) return null;
    return { id, rolloutPath };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

// The newest unarchived interactive (`source = 'cli'`) thread for `cwd`. The `source` predicate
// preserves Codex's own exclusion of non-interactive `exec` and subagent threads; the query is
// served by Codex's `idx_threads_archived_cwd_recency_at_ms` index.
function indexedCodexLatest(home: string, cwd: string): IndexedCodexThread | null {
  return queryCodexIndex(
    home,
    "SELECT id, rollout_path FROM threads WHERE archived = 0 AND cwd = $cwd AND source = 'cli' ORDER BY recency_at_ms DESC, id DESC LIMIT 1",
    { cwd },
  );
}

// The unarchived thread with this exact primary-key id (never a substring match).
function indexedCodexById(home: string, id: string): IndexedCodexThread | null {
  return queryCodexIndex(
    home,
    "SELECT id, rollout_path FROM threads WHERE archived = 0 AND id = $id LIMIT 1",
    { id },
  );
}

// Validate an indexed row against the filesystem so a stale/corrupt index is only ever a cache
// miss. The rollout must stay under `<codexHome>/sessions`, be a regular (non-symlink) rollout
// file, and its `session_meta` must agree with the row's id (and cwd, when required). Returns the
// validated absolute path, or null so the caller runs the existing scan instead.
function validatedCodexRollout(
  home: string,
  thread: IndexedCodexThread | null,
  requiredCwd: string | null,
): string | null {
  if (thread === null) return null;
  const lexical = resolve(thread.rolloutPath);
  // Reject a symlink at the final rollout entry (lstatSync does not follow the last component).
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(lexical);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  // Canonicalize both the sessions root and the rollout through the filesystem, then do a
  // path-component-safe containment check on the real paths -- a lexical prefix check alone would
  // let a symlinked *parent* component (e.g. .../sessions/2026/08/link -> outside) escape the tree.
  let root: string;
  let path: string;
  try {
    root = realpathSync(join(codexHome(home), "sessions"));
    path = realpathSync(lexical);
  } catch {
    return null;
  }
  if (path !== root && !path.startsWith(`${root}/`)) return null;
  if (!isCodexRolloutFile(basename(path))) return null;
  if (codexRolloutSessionId(path) !== thread.id) return null;
  if (requiredCwd !== null && codexRolloutCwd(path) !== requiredCwd) return null;
  return path;
}

// An agent adapter bundles everything ccc-morph needs to observe one CLI's session: where it
// writes transcripts, how to recognize/parse them, and its resume-flag grammar. Adding a new
// agent is a matter of adding one adapter to ADAPTERS -- OutputCapture stays agent-agnostic.
export interface AgentAdapter {
  // Command basenames (and config aliases) this adapter answers to.
  readonly names: readonly string[];
  // The directory to scan for this agent's per-session transcripts, its filename filter, and
  // how deep to recurse (Claude keeps a flat per-project dir; Codex nests under sessions/Y/M/D).
  transcriptRoot(home: string, cwd: string): string;
  matchesFile(name: string): boolean;
  readonly scanDepth: number;
  // Whether a transcript belongs to our cwd. Claude's dir is already cwd-scoped (always true);
  // Codex rollouts span cwds, so compare the recorded session_meta.cwd.
  matchesCwd(path: string, cwd: string): boolean;
  // The session id a transcript records, for explicit `--resume <id>` matching.
  sessionId(path: string): string | null;
  // Parsers over the (whole-line) transcript tail.
  latestMessage(jsonlTail: string, cap: number): string;
  messages(jsonlTail: string, cap: number, n: number): TranscriptMessage[];
  // Resume-intent grammar for this agent's argv (everything after the wrapped program name).
  detectResume(args: string[]): ResumeIntent;
}

const claudeAdapter: AgentAdapter = {
  names: ["claude"],
  // Claude Code names its per-project transcript dir by the cwd with every non-alphanumeric
  // char turned into "-" (e.g. /a/b-v1.2 -> -a-b-v1-2).
  transcriptRoot: (home, cwd) =>
    join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")),
  matchesFile: (name) => name.endsWith(".jsonl"),
  scanDepth: 0,
  matchesCwd: () => true, // the transcript dir is already scoped to this cwd
  sessionId: (path) => basename(path).replace(/\.jsonl$/, ""),
  latestMessage: extractClaudeLatestMessage,
  messages: extractClaudeMessages,
  detectResume: detectClaudeResume,
};

const codexAdapter: AgentAdapter = {
  names: ["codex", "codex-cli"],
  transcriptRoot: (home) => join(codexHome(home), "sessions"),
  matchesFile: isCodexRolloutFile,
  scanDepth: 4,
  matchesCwd: (path, cwd) => codexRolloutCwd(path) === cwd,
  sessionId: codexRolloutSessionId,
  latestMessage: extractCodexLatestMessage,
  messages: extractCodexMessages,
  detectResume: detectCodexResume,
};

const ADAPTERS: readonly AgentAdapter[] = [claudeAdapter, codexAdapter];

// The adapter for a resolved app identity (config appName or the wrapped executable basename),
// or null for an unknown program -- capture then has no transcript and falls back to the raw
// terminal buffer.
export function adapterFor(commandName: string): AgentAdapter | null {
  return ADAPTERS.find((adapter) => adapter.names.includes(commandName)) ?? null;
}

// Captures the wrapped program's output for on-demand retrieval. Feeds the raw PTY
// byte stream into a bounded ring buffer; recent() prefers a known app's latest agent
// message (from its JSONL transcript) and falls back to the ANSI-stripped raw buffer.
export class OutputCapture {
  readonly #adapter: AgentAdapter | null;
  readonly #cwd: string;
  readonly #capBytes: number;
  readonly #readCap: number;
  readonly #resumeLatest: boolean;
  readonly #resumeSessionId: string | null;
  readonly #home: string;
  // Paths of transcript files that already existed at launch. A candidate is this session's own
  // only if it is absent from this set (created after we launched). Ownership is decided by
  // presence, not mtime, so a concurrent session appending to a *pre-existing* transcript is
  // never mistaken for ours. This is also why the interactive picker has no response history: it
  // resumes a pre-existing transcript, not one of our post-launch files (see #sessionFile).
  //
  // KNOWN LIMITATION: presence-since-launch is not proof of process ownership. If another Claude
  // or Codex process starts in this same cwd after we launch and creates its own transcript, that
  // new file is also absent from this set, so capture can surface the other conversation. `c`/`C`
  // therefore assume one wrapped agent session per workspace (see docs/configuration.md). An
  // explicit `--resume <id>` pins that exact transcript; the interactive picker is no-history.
  readonly #launchSnapshot: Set<string>;
  // For a deterministic Codex resume (`resume <id>` / `resume --last`), the transcript resolved
  // once at construction -- from Codex's thread index when available, else the existing scan --
  // and pinned, so a concurrently-created rollout cannot later replace the session Codex was told
  // to resume. Null for Claude, fresh/picker Codex, unknown programs, or no match.
  readonly #prelaunchResumeFile: string | null;
  // The recursive transcript/rollout collector (the real filesystem walk in production; a stub in
  // tests). Injected so tests can assert an indexed Codex resume performs no scan.
  readonly #collect: (
    dir: string,
    match: (name: string) => boolean,
    depth: number,
  ) => { path: string; mtimeMs: number }[];
  #chunks: Uint8Array[] = [];
  #bytes = 0;

  constructor(options: CaptureOptions) {
    this.#adapter = adapterFor(options.commandName);
    this.#cwd = options.cwd;
    this.#capBytes = options.capBytes ?? DEFAULT_CAPTURE_BYTES;
    this.#readCap = options.readCapBytes ?? DEFAULT_TRANSCRIPT_READ_BYTES;
    this.#resumeLatest = options.resumeLatest ?? false;
    this.#resumeSessionId = options.resumeSessionId ?? null;
    this.#home = options.home ?? homedir();
    this.#collect = options.collect ?? ((dir, match, depth) => collectFiles(dir, match, depth));
    // Resolve a deterministic Codex resume target FIRST. On a thread-index hit this returns without
    // any rollout scan; the pinned target then wins in #sessionFile, so the launch snapshot -- which
    // is only consulted when there is no pin -- is skipped, avoiding the recursive tree walk that
    // the index lookup is meant to replace.
    this.#prelaunchResumeFile = this.#resolvePrelaunchResumeFile();
    this.#launchSnapshot =
      this.#prelaunchResumeFile === null
        ? new Set(this.#candidates().map((file) => file.path))
        : new Set();
  }

  // Resolve a deterministic Codex resume target (see #prelaunchResumeFile). Index-first for speed
  // and authority, then the existing scan; the scan result is pinned too so the choice is stable
  // against later files. Only the Codex adapter's `resume <id>` / `resume --last` intents qualify;
  // everything else uses the normal per-press selection in #sessionFile.
  #resolvePrelaunchResumeFile(): string | null {
    if (this.#adapter !== codexAdapter) return null;
    if (this.#resumeSessionId !== null) {
      const indexed = validatedCodexRollout(
        this.#home,
        indexedCodexById(this.#home, this.#resumeSessionId),
        null,
      );
      if (indexed !== null) return indexed;
      return (
        this.#candidates().find(
          (file) => codexRolloutSessionId(file.path) === this.#resumeSessionId,
        )?.path ?? null
      );
    }
    if (this.#resumeLatest) {
      const indexed = validatedCodexRollout(
        this.#home,
        indexedCodexLatest(this.#home, this.#cwd),
        this.#cwd,
      );
      if (indexed !== null) return indexed;
      return (
        this.#candidates()
          .slice(0, 40)
          .find((file) => codexRolloutCwd(file.path) === this.#cwd)?.path ?? null
      );
    }
    return null;
  }

  feed(data: Uint8Array): void {
    if (data.length === 0) return;
    this.#chunks.push(data.slice());
    this.#bytes += data.length;
    while (this.#bytes > this.#capBytes && this.#chunks.length > 1) {
      const dropped = this.#chunks.shift();
      if (dropped) this.#bytes -= dropped.length;
    }
    // A single oversized chunk is trimmed to keep the tail.
    if (this.#bytes > this.#capBytes && this.#chunks.length === 1) {
      const only = this.#chunks[0]!;
      this.#chunks[0] = only.subarray(only.length - this.#capBytes);
      this.#bytes = this.#capBytes;
    }
  }

  // Best recent text: a known app's latest agent message if available, else the raw buffer.
  recent(): string {
    const file = this.#sessionFile();
    if (file !== null && this.#adapter !== null) {
      try {
        const extracted = this.#adapter.latestMessage(
          readTail(file, this.#readCap),
          this.#capBytes,
        );
        if (extracted.trim().length > 0) return extracted;
      } catch {
        // fall through to the raw buffer
      }
    }
    return stripAnsi(new TextDecoder().decode(Buffer.concat(this.#chunks)));
  }

  // Recent conversation turns (oldest-first, both roles) from a known app's transcript,
  // for the notes response browser; [] when there is no transcript to read. Only the tail
  // of the transcript is read, so both the scan and any retained plans are byte-bounded.
  // n<=0 returns every turn in the read window.
  latestMessages(n: number): TranscriptMessage[] {
    const file = this.#sessionFile();
    if (file === null || this.#adapter === null) return [];
    try {
      return this.#adapter.messages(readTail(file, this.#readCap), this.#capBytes, n);
    } catch {
      return [];
    }
  }

  // Matching transcript files for this adapter (path + mtime), newest-first; [] for an
  // unknown program. Claude Code partitions by cwd slug (flat dir); Codex nests rollouts
  // under sessions/YYYY/MM/DD.
  #candidates(): { path: string; mtimeMs: number }[] {
    const adapter = this.#adapter;
    if (adapter === null) return [];
    return this.#collect(
      adapter.transcriptRoot(this.#home, this.#cwd),
      (name) => adapter.matchesFile(name),
      adapter.scanDepth,
    ).sort((left, right) => right.mtimeMs - left.mtimeMs);
  }

  // Locate this session's JSONL transcript. A candidate is "own" only if it was created after
  // launch (absent from the launch snapshot) and recorded for our cwd; ownership is by presence,
  // not mtime, so a concurrent session appending to a *pre-existing* same-cwd transcript is never
  // adopted. A fresh launch with no own transcript yet returns null so the caller uses the raw
  // buffer rather than another session's content; a transcript that predates launch is used only
  // when resuming the latest. (Known limitation: a *newly created* concurrent same-cwd transcript
  // is also absent from the snapshot and can be adopted -- see the #launchSnapshot note.)
  #sessionFile(): string | null {
    const adapter = this.#adapter;
    if (adapter === null) return null;
    // A deterministic Codex resume target pinned at construction is the session Codex was told to
    // resume; it wins over any generic post-launch candidate so a concurrently-created rollout
    // cannot replace it. If it later disappears, the bounded read in recent()/latestMessages()
    // falls back to the raw buffer, matching the unknown-transcript behavior.
    if (this.#prelaunchResumeFile !== null) return this.#prelaunchResumeFile;
    const candidates = this.#candidates();
    // An explicit resume selector is the strongest signal: resolve it across all candidates and
    // either return its exact transcript or decline to the raw buffer -- an unrelated session's
    // post-launch transcript must never override it. (Claude: `<id>.jsonl`; Codex: session_meta id.)
    if (this.#resumeSessionId !== null) {
      const id = this.#resumeSessionId;
      return candidates.find((file) => adapter.sessionId(file.path) === id)?.path ?? null;
    }
    // Our own newest transcript for this cwd: created after launch (the 40-file cap bounds the
    // per-file cwd probe on Codex; on Claude matchesCwd is trivially true).
    const own = candidates.filter((file) => !this.#launchSnapshot.has(file.path));
    const ownMatch = own.slice(0, 40).find((file) => adapter.matchesCwd(file.path, this.#cwd));
    if (ownMatch !== undefined) return ownMatch.path;
    // Resume-latest (`--continue` / `resume --last`) reuses the newest pre-launch transcript for
    // this cwd. The interactive picker does NOT: its chosen session is a pre-existing transcript
    // we cannot tell apart from another concurrent same-cwd session, so we decline to the raw
    // buffer (no history) rather than risk surfacing a different conversation.
    if (!this.#resumeLatest) return null;
    return (
      candidates.slice(0, 40).find((file) => adapter.matchesCwd(file.path, this.#cwd))?.path ?? null
    );
  }
}
