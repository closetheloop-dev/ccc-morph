import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adapterFor,
  extractClaudeLatestMessage,
  extractClaudeMessages,
  extractCodexLatestMessage,
  extractCodexMessages,
  OutputCapture,
  stripAnsi,
} from "../src/output-capture";

const enc = (s: string) => new TextEncoder().encode(s);

describe("output capture", () => {
  test("stripAnsi removes CSI and OSC escape sequences", () => {
    const raw = "\x1b[31mred\x1b[0m plain \x1b[2J\x1b]0;title\x07 end";
    const clean = stripAnsi(raw);
    expect(clean).not.toContain("\x1b");
    expect(clean).toContain("red");
    expect(clean).toContain("plain");
    expect(clean).toContain("end");
  });

  test("the ring buffer keeps only the last capBytes", () => {
    const capture = new OutputCapture({
      commandName: "bash",
      cwd: "/no/session",
      capBytes: 10,
    });
    capture.feed(enc("aaaaa"));
    capture.feed(enc("bbbbb"));
    capture.feed(enc("ccccc")); // total 15 -> oldest chunk dropped
    expect(capture.recent()).toBe("bbbbbccccc");
  });

  test("a single oversized chunk is trimmed to the tail", () => {
    const capture = new OutputCapture({
      commandName: "bash",
      cwd: "/no/session",
      capBytes: 5,
    });
    capture.feed(enc("0123456789"));
    expect(capture.recent()).toBe("56789");
  });

  test("extractClaudeLatestMessage returns only the last assistant message, no role prefix", () => {
    const jsonl = [
      JSON.stringify({ type: "user", message: { role: "user", content: "hello there" } }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "first reply" }] },
      }),
      JSON.stringify({ type: "user", message: { role: "user", content: "and again?" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "second reply" },
            { type: "tool_use", name: "x" },
          ],
        },
      }),
      JSON.stringify({ type: "system", content: "ignored" }),
    ].join("\n");
    // Only the newest assistant turn, and no "assistant:" prefix.
    expect(extractClaudeLatestMessage(jsonl, 10_000)).toBe("second reply");
  });

  test("extractClaudeLatestMessage is empty when there is no assistant turn yet", () => {
    const jsonl = JSON.stringify({
      type: "user",
      message: { role: "user", content: "just asked" },
    });
    expect(extractClaudeLatestMessage(jsonl, 10_000)).toBe("");
  });

  test("extractCodexLatestMessage returns only the last assistant message", () => {
    const jsonl = [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "run tests" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "working on it" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done, all green" }],
        },
      }),
      JSON.stringify({ type: "event", payload: { type: "other" } }),
    ].join("\n");
    expect(extractCodexLatestMessage(jsonl, 10_000)).toBe("done, all green");
  });

  test("recent() prefers a known app's latest assistant message over the raw buffer", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-morph-capture-home-"));
    try {
      const cwd = "/work/proj";
      const dir = join(home, ".claude", "projects", cwd.replace(/\//g, "-"));
      mkdirSync(dir, { recursive: true });
      // Construct first (empty launch snapshot), then the child writes its own transcript.
      const capture = new OutputCapture({ commandName: "claude", cwd, home });
      writeFileSync(
        join(dir, "session.jsonl"),
        `${JSON.stringify({ type: "user", message: { role: "user", content: "hello there" } })}\n${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } })}\n`,
      );
      capture.feed(enc("this raw PTY text should be ignored"));
      expect(capture.recent()).toBe("hi");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("recent() slugifies a dotted cwd the way Claude Code does (every non-alnum -> -)", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-morph-capture-slug-"));
    try {
      const cwd = "/home/dev/ccc-morph-v0.2.0"; // dots must become dashes: -home-dev-ccc-morph-v0-2-0
      const dir = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(dir, { recursive: true });
      const capture = new OutputCapture({ commandName: "claude", cwd, home });
      writeFileSync(
        join(dir, "session.jsonl"),
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "found the transcript" }] } })}\n`,
      );
      capture.feed(enc("raw buffer that must be ignored"));
      // A "/"-only slug would look in "...-v0.2.0" and miss this dir, falling back to the buffer.
      expect(capture.recent()).toBe("found the transcript");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("recent() falls back to the raw buffer when no session file exists", () => {
    const capture = new OutputCapture({
      commandName: "claude",
      cwd: "/definitely/not/a/real/project/path",
    });
    capture.feed(enc("raw output here"));
    expect(capture.recent()).toBe("raw output here");
  });

  test("recent() finds a Codex rollout nested under sessions/YYYY/MM/DD and matches by cwd", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-morph-capture-codex-"));
    try {
      const cwd = "/work/proj";
      const dir = join(home, ".codex", "sessions", "2026", "07", "31");
      mkdirSync(dir, { recursive: true });
      const capture = new OutputCapture({ commandName: "codex", cwd, home });
      const meta = JSON.stringify({ type: "session_meta", payload: { cwd } });
      const msg = JSON.stringify({
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "codex reply" }],
        },
      });
      writeFileSync(join(dir, "rollout-2026-07-31T00-00-00-abc.jsonl"), `${meta}\n${msg}\n`);
      capture.feed(enc("raw buffer that must be ignored"));
      // A flat (non-recursive) locator would miss this date-nested file and return the buffer.
      expect(capture.recent()).toBe("codex reply");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a fresh (non-resume) Codex launch does not capture a pre-existing same-cwd rollout", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-morph-capture-codexstale-"));
    try {
      const cwd = "/work/proj";
      const dir = join(home, ".codex", "sessions", "2026", "07", "31");
      mkdirSync(dir, { recursive: true });
      const meta = JSON.stringify({ type: "session_meta", payload: { cwd } });
      const msg = JSON.stringify({
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "stale rollout reply" }],
        },
      });
      // The rollout for this cwd already exists at launch, and this is not a resume, so it
      // belongs to another session and must not be captured.
      writeFileSync(join(dir, "rollout-2026-07-31T00-00-00-old.jsonl"), `${meta}\n${msg}\n`);
      const capture = new OutputCapture({ commandName: "codex", cwd, home });
      capture.feed(enc("fresh session buffer"));
      expect(capture.recent()).toBe("fresh session buffer");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("recent() uses the cwd's pre-existing Codex rollout only when resuming (resume --last)", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-morph-capture-resume-"));
    try {
      const cwd = "/work/proj";
      const dir = join(home, ".codex", "sessions", "2026", "07", "31");
      mkdirSync(dir, { recursive: true });
      const meta = JSON.stringify({ type: "session_meta", payload: { cwd } });
      const msg = JSON.stringify({
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "resumed reply" }],
        },
      });
      // The rollout predates launch and a resume does not rewrite it until a new turn, so it
      // is not "own"; resume-latest intent lets capture fall back to the cwd match.
      writeFileSync(join(dir, "rollout-2026-07-31T00-00-00-old.jsonl"), `${meta}\n${msg}\n`);
      const capture = new OutputCapture({ commandName: "codex", cwd, home, resumeLatest: true });
      capture.feed(enc("raw buffer that must be ignored"));
      expect(capture.recent()).toBe("resumed reply");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the Codex picker never captures a same-cwd rollout, even after it changes post-launch", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-morph-capture-picker-"));
    try {
      const cwd = "/work/proj";
      const dir = join(home, ".codex", "sessions", "2026", "07", "31");
      mkdirSync(dir, { recursive: true });
      const rollout = (text: string) =>
        `${JSON.stringify({ type: "session_meta", payload: { cwd } })}\n${JSON.stringify({
          payload: { type: "message", role: "assistant", content: [{ type: "text", text }] },
        })}\n`;
      const decoy = join(dir, "rollout-2026-07-31T00-00-00-decoy.jsonl");
      writeFileSync(decoy, rollout("some other session in this cwd"));
      const past = new Date(Date.now() - 60_000);
      utimesSync(decoy, past, past);
      // Picker resume (no --last, no id): a pre-existing rollout is never adopted.
      const capture = new OutputCapture({ commandName: "codex", cwd, home });
      capture.feed(enc("raw buffer"));
      expect(capture.recent()).toBe("raw buffer");
      // A concurrent Codex session in THIS cwd appends to its own rollout after launch. mtime
      // advancing must NOT make capture adopt it -- it is not our session.
      writeFileSync(decoy, rollout("concurrent session reply"));
      utimesSync(decoy, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
      expect(capture.recent()).toBe("raw buffer");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the Codex picker never captures a same-cwd decoy changing alongside the selected rollout", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-morph-capture-picker2-"));
    try {
      const cwd = "/work/proj";
      const dir = join(home, ".codex", "sessions", "2026", "07", "31");
      mkdirSync(dir, { recursive: true });
      const rollout = (text: string) =>
        `${JSON.stringify({ type: "session_meta", payload: { cwd } })}\n${JSON.stringify({
          payload: { type: "message", role: "assistant", content: [{ type: "text", text }] },
        })}\n`;
      const selected = join(dir, "rollout-2026-07-31T00-00-00-selected.jsonl");
      const decoy = join(dir, "rollout-2026-07-31T00-00-05-decoy.jsonl");
      writeFileSync(selected, rollout("selected old"));
      writeFileSync(decoy, rollout("decoy old"));
      const past = new Date(Date.now() - 60_000);
      utimesSync(selected, past, past);
      utimesSync(decoy, past, past);
      const capture = new OutputCapture({ commandName: "codex", cwd, home });
      capture.feed(enc("raw buffer"));
      // Both the selected session and a concurrent same-cwd decoy change after launch. The picker
      // never adopts a post-launch transcript, so capture stays on the raw buffer.
      writeFileSync(selected, rollout("selected new reply"));
      writeFileSync(decoy, rollout("decoy new reply"));
      utimesSync(selected, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
      utimesSync(decoy, new Date(Date.now() + 20_000), new Date(Date.now() + 20_000));
      expect(capture.recent()).toBe("raw buffer");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the Claude picker never captures a same-project transcript that changes post-launch", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-morph-capture-claudepicker-"));
    try {
      const cwd = "/work/proj";
      const dir = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(dir, { recursive: true });
      const line = (text: string) =>
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
      // Two pre-existing transcripts in the SAME project dir (Claude groups by cwd), so neither
      // is distinguishable as "ours".
      const selected = join(dir, "selected.jsonl");
      const decoy = join(dir, "decoy.jsonl");
      writeFileSync(selected, line("selected old"));
      writeFileSync(decoy, line("decoy old"));
      const past = new Date(Date.now() - 60_000);
      utimesSync(selected, past, past);
      utimesSync(decoy, past, past);
      const capture = new OutputCapture({ commandName: "claude", cwd, home });
      capture.feed(enc("raw buffer"));
      expect(capture.recent()).toBe("raw buffer");
      // Both change after launch (the resumed pick and a concurrent same-project session); with
      // no way to tell which is ours, capture never adopts a pre-existing transcript.
      writeFileSync(selected, line("selected new reply"));
      writeFileSync(decoy, line("decoy new reply"));
      utimesSync(selected, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
      utimesSync(decoy, new Date(Date.now() + 20_000), new Date(Date.now() + 20_000));
      expect(capture.recent()).toBe("raw buffer");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an explicit Codex resume <id> matches the exact session_meta id, not a filename substring", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-morph-capture-codexid-"));
    try {
      const cwd = "/work/proj";
      const dir = join(home, ".codex", "sessions", "2026", "07", "31");
      mkdirSync(dir, { recursive: true });
      const rollout = (sessionId: string, text: string) =>
        `${JSON.stringify({ type: "session_meta", payload: { cwd, session_id: sessionId } })}\n${JSON.stringify(
          { payload: { type: "message", role: "assistant", content: [{ type: "text", text }] } },
        )}\n`;
      // A decoy whose id "abc123" merely *contains* the requested "abc", written newest so a
      // substring match would prefer it; and the exact match "abc".
      writeFileSync(
        join(dir, "rollout-2026-07-31T00-00-00-abc.jsonl"),
        rollout("abc", "exact reply"),
      );
      writeFileSync(
        join(dir, "rollout-2026-07-31T00-00-01-abc123.jsonl"),
        rollout("abc123", "decoy reply"),
      );
      const capture = new OutputCapture({
        commandName: "codex",
        cwd,
        home,
        resumeSessionId: "abc",
      });
      capture.feed(enc("buffer"));
      expect(capture.recent()).toBe("exact reply");
      // A concurrent session's NEW rollout after launch must not override the explicit id.
      writeFileSync(
        join(dir, "rollout-2026-07-31T00-00-09-newsess.jsonl"),
        rollout("newsess", "concurrent new reply"),
      );
      expect(capture.recent()).toBe("exact reply");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an explicit Claude --resume <id> selects that session's transcript, never another", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-morph-capture-resumeid-"));
    try {
      const cwd = "/work/proj";
      const dir = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(dir, { recursive: true });
      const line = (text: string) =>
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
      // Two pre-existing sessions; the requested one is written first (older).
      writeFileSync(join(dir, "wanted-id.jsonl"), line("wanted session reply"));
      writeFileSync(join(dir, "other-id.jsonl"), line("other session reply"));
      const wanted = new OutputCapture({
        commandName: "claude",
        cwd,
        home,
        resumeSessionId: "wanted-id",
      });
      wanted.feed(enc("buffer"));
      // Even though other-id.jsonl is newest, the explicit id pins the requested session.
      expect(wanted.recent()).toBe("wanted session reply");
      // A concurrent session creates a NEW transcript after launch (a generic "own" candidate);
      // the explicit id must still win over it.
      writeFileSync(join(dir, "concurrent-new.jsonl"), line("concurrent new session"));
      expect(wanted.recent()).toBe("wanted session reply");
      // An id that matches no transcript declines the fallback (raw buffer), not another session.
      const missing = new OutputCapture({
        commandName: "claude",
        cwd,
        home,
        resumeSessionId: "no-such-id",
      });
      missing.feed(enc("buffer only"));
      expect(missing.recent()).toBe("buffer only");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Claude continue reuses the newest transcript, but the picker declines to the buffer", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-morph-capture-claude-picker-"));
    try {
      const cwd = "/work/proj";
      const dir = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(dir, { recursive: true });
      const line = (text: string) =>
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
      writeFileSync(join(dir, "older.jsonl"), line("older reply"));
      writeFileSync(join(dir, "newest.jsonl"), line("newest reply"));
      // --continue (resume-latest) reuses the newest pre-launch transcript.
      const cont = new OutputCapture({ commandName: "claude", cwd, home, resumeLatest: true });
      cont.feed(enc("raw buffer"));
      expect(cont.recent()).toBe("newest reply");
      // The picker (bare --resume) must NOT guess the newest; it resumes a pre-existing
      // transcript we cannot identify, so it declines to the raw buffer (no history).
      const picker = new OutputCapture({ commandName: "claude", cwd, home, resumeLatest: false });
      picker.feed(enc("raw buffer"));
      expect(picker.recent()).toBe("raw buffer");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("extractClaudeMessages interleaves both roles oldest-first and maps assistant->agent", () => {
    const jsonl = [
      JSON.stringify({ type: "user", message: { role: "user", content: "first question" } }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "first reply" }] },
      }),
      // A tool_result user record flattens to "" and is dropped.
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "x" }] },
      }),
      JSON.stringify({ type: "user", message: { role: "user", content: "second question" } }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "second reply" }] },
      }),
    ].join("\n");
    expect(extractClaudeMessages(jsonl, 10_000, 0)).toEqual([
      { role: "user", text: "first question" },
      { role: "agent", text: "first reply" },
      { role: "user", text: "second question" },
      { role: "agent", text: "second reply" },
    ]);
    // n>0 keeps only the last n turns.
    expect(extractClaudeMessages(jsonl, 10_000, 2)).toEqual([
      { role: "user", text: "second question" },
      { role: "agent", text: "second reply" },
    ]);
  });

  test("extractClaudeMessages drops synthetic user records (slash-command bookkeeping, isMeta)", () => {
    const jsonl = [
      JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>notes" } }),
      JSON.stringify({
        type: "user",
        isMeta: true,
        message: { role: "user", content: "caveat text" },
      }),
      JSON.stringify({ type: "user", message: { role: "user", content: "the real prompt" } }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "an answer" }] },
      }),
    ].join("\n");
    expect(extractClaudeMessages(jsonl, 10_000, 0)).toEqual([
      { role: "user", text: "the real prompt" },
      { role: "agent", text: "an answer" },
    ]);
  });

  test("agent-only filtering yields the browsable responses in order (the browser's derivation)", () => {
    const jsonl = [
      JSON.stringify({ type: "user", message: { role: "user", content: "q1" } }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "a1" }] },
      }),
      JSON.stringify({ type: "user", message: { role: "user", content: "q2" } }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "a2" }] },
      }),
    ].join("\n");
    const responses = extractClaudeMessages(jsonl, 10_000, 0).filter((m) => m.role === "agent");
    expect(responses.map((m) => m.text)).toEqual(["a1", "a2"]);
  });

  test("extractCodexMessages interleaves both roles and maps assistant->agent", () => {
    const jsonl = [
      JSON.stringify({
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "do X" }] },
      }),
      JSON.stringify({
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        },
      }),
      JSON.stringify({
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "now Y" }],
        },
      }),
    ].join("\n");
    expect(extractCodexMessages(jsonl, 10_000, 0)).toEqual([
      { role: "user", text: "do X" },
      { role: "agent", text: "ok" },
      { role: "user", text: "now Y" },
    ]);
    expect(extractCodexMessages(jsonl, 10_000, 1)).toEqual([{ role: "user", text: "now Y" }]);
  });

  test("extractClaudeMessages surfaces an ExitPlanMode plan as a kind:'plan' item, in order", () => {
    const plan = "# My Plan\n\nstep one\nstep two";
    const jsonl = [
      JSON.stringify({ type: "user", message: { role: "user", content: "please plan" } }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "here is my thinking" }] },
      }),
      // A pure tool_use ExitPlanMode record (no text block) — the common shape.
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "ExitPlanMode", input: { plan } }],
        },
      }),
    ].join("\n");
    expect(extractClaudeMessages(jsonl, 10_000, 0)).toEqual([
      { role: "user", text: "please plan" },
      { role: "agent", text: "here is my thinking" },
      { role: "agent", text: plan, kind: "plan" },
    ]);
  });

  test("extractClaudeMessages surfaces a newer Claude plan-file Write as a kind:'plan' item", () => {
    const plan = "# Add reverse()\n\n## Context\n…\n\n## The change\nappend one export";
    const jsonl = [
      JSON.stringify({ type: "user", message: { role: "user", content: "please plan" } }),
      // Newer Claude writes the plan markdown to ~/.claude/plans/<slug>.md via Write.
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "Write",
              input: { file_path: "/home/u/.claude/plans/add-reverse-foo.md", content: plan },
            },
          ],
        },
      }),
    ].join("\n");
    expect(extractClaudeMessages(jsonl, 10_000, 0)).toEqual([
      { role: "user", text: "please plan" },
      { role: "agent", text: plan, kind: "plan" },
    ]);
  });

  test("newer Claude's duplicate plan (ExitPlanMode + identical plan-file Write) yields one plan item", () => {
    const plan = "# Add reverse()\n\n## Context\nstuff\n\n## Change\nappend one export";
    const jsonl = [
      JSON.stringify({ type: "user", message: { role: "user", content: "plan it" } }),
      // Interactive plan mode emits both, with identical content, in adjacent records.
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "ExitPlanMode", input: { plan } }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "Write",
              input: { file_path: "/h/.claude/plans/x.md", content: plan },
            },
          ],
        },
      }),
    ].join("\n");
    expect(extractClaudeMessages(jsonl, 10_000, 0)).toEqual([
      { role: "user", text: "plan it" },
      { role: "agent", text: plan, kind: "plan" },
    ]);
  });

  test("a Write to a non-plans path is not treated as a plan", () => {
    const jsonl = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Write",
            input: { file_path: "/home/u/project/src/index.ts", content: "export const x = 1" },
          },
        ],
      },
    });
    expect(extractClaudeMessages(jsonl, 10_000, 0)).toEqual([]);
  });

  test("a Write whose path merely contains '.claude/plans/' as a substring is not a plan", () => {
    const jsonl = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Write",
            // '.claude' and 'plans' must be whole path components; 'not.claude' is not '.claude'.
            input: { file_path: "/workspace/not.claude/plans/result.md", content: "# Nope\n- x" },
          },
        ],
      },
    });
    expect(extractClaudeMessages(jsonl, 10_000, 0)).toEqual([]);
  });

  test("an identical plan re-proposed in a later turn is kept (dedup is per-turn)", () => {
    const plan = "# Add reverse()\n\n## Change\nappend one export";
    const jsonl = [
      JSON.stringify({ type: "user", message: { role: "user", content: "plan it" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "ExitPlanMode", input: { plan } }],
        },
      }),
      // A later conversational turn: the user asks again and the assistant re-proposes the SAME
      // plan. The intervening user prompt makes this a distinct emission, not a paired duplicate.
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "re-plan the same thing" },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "ExitPlanMode", input: { plan } }],
        },
      }),
    ].join("\n");
    expect(extractClaudeMessages(jsonl, 10_000, 0)).toEqual([
      { role: "user", text: "plan it" },
      { role: "agent", text: plan, kind: "plan" },
      { role: "user", text: "re-plan the same thing" },
      { role: "agent", text: plan, kind: "plan" },
    ]);
  });

  test("a non-ExitPlanMode tool_use record contributes nothing, and Codex items carry no kind", () => {
    const claude = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
      },
    });
    expect(extractClaudeMessages(claude, 10_000, 0)).toEqual([]);
    const codex = JSON.stringify({
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      },
    });
    expect(extractCodexMessages(codex, 10_000, 0)).toEqual([{ role: "agent", text: "done" }]);
    expect(extractCodexMessages(codex, 10_000, 0)[0]).not.toHaveProperty("kind");
  });

  test("extractCodexMessages surfaces each <proposed_plan> as a kind:'plan' item (tags stripped)", () => {
    const planA = "# Plan A\n\nstep one";
    const planB = "# Plan B\n\nrevised step";
    const jsonl = [
      JSON.stringify({
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "please plan" }],
        },
      }),
      JSON.stringify({
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: `<proposed_plan>\n${planA}\n</proposed_plan>` }],
        },
      }),
      JSON.stringify({
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "revise it" }],
        },
      }),
      JSON.stringify({
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: `<proposed_plan>\n${planB}\n</proposed_plan>` }],
        },
      }),
    ].join("\n");
    expect(extractCodexMessages(jsonl, 10_000, 0)).toEqual([
      { role: "user", text: "please plan" },
      { role: "agent", text: planA, kind: "plan" },
      { role: "user", text: "revise it" },
      { role: "agent", text: planB, kind: "plan" },
    ]);
  });

  test("extractCodexMessages keeps a Plan Mode answer before the block as a plain response", () => {
    const plan = "# The Plan\n\ndo it";
    const jsonl = JSON.stringify({
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: `Sure, Python it is.\n\n<proposed_plan>\n${plan}\n</proposed_plan>`,
          },
        ],
      },
    });
    expect(extractCodexMessages(jsonl, 10_000, 0)).toEqual([
      { role: "agent", text: "Sure, Python it is." },
      { role: "agent", text: plan, kind: "plan" },
    ]);
  });

  test("extractCodexMessages skips developer/system instruction messages (no false plan)", () => {
    // A developer instruction that itself documents the <proposed_plan> convention must not
    // leak as a response, nor be mis-read as a plan.
    const jsonl = [
      JSON.stringify({
        payload: {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "# Plan Mode\nWrap the plan in <proposed_plan>...</proposed_plan>.",
            },
          ],
        },
      }),
      JSON.stringify({
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "a real response" }],
        },
      }),
    ].join("\n");
    expect(extractCodexMessages(jsonl, 10_000, 0)).toEqual([
      { role: "agent", text: "a real response" },
    ]);
  });

  test("latestMessages reads a Claude transcript; non-transcript apps return []", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-morph-capture-history-"));
    try {
      const cwd = "/work/proj";
      const dir = join(home, ".claude", "projects", cwd.replace(/\//g, "-"));
      mkdirSync(dir, { recursive: true });
      const claude = new OutputCapture({ commandName: "claude", cwd, home });
      writeFileSync(
        join(dir, "session.jsonl"),
        `${JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })}\n${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } })}\n`,
      );
      expect(claude.latestMessages(0)).toEqual([
        { role: "user", text: "hi" },
        { role: "agent", text: "hello" },
      ]);
      // A wrapped shell has no JSONL transcript, so there is nothing to browse.
      const bash = new OutputCapture({ commandName: "bash", cwd, home });
      expect(bash.latestMessages(0)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("recent() picks the newest transcript when several exist", async () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-morph-capture-newest-"));
    try {
      const cwd = "/work/proj";
      const dir = join(home, ".claude", "projects", cwd.replace(/\//g, "-"));
      mkdirSync(dir, { recursive: true });
      const capture = new OutputCapture({ commandName: "claude", cwd, home });
      // Both transcripts are written after launch, so both are this session's own.
      writeFileSync(
        join(dir, "old.jsonl"),
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "OLD reply" }] } })}\n`,
      );
      await Bun.sleep(15);
      writeFileSync(
        join(dir, "new.jsonl"),
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "NEW reply" }] } })}\n`,
      );
      expect(capture.recent()).toBe("NEW reply");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("recent() ignores an earlier session's stale same-cwd transcript, then uses this session's own", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-morph-capture-freshcwd-"));
    try {
      const cwd = "/work/proj";
      const dir = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(dir, { recursive: true });
      // An earlier session left a transcript in this cwd before we launch.
      writeFileSync(
        join(dir, "earlier-session.jsonl"),
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "reply from an earlier session" }] } })}\n`,
      );
      // Fresh (non-resume) launch: the earlier transcript is in the launch snapshot, so it is
      // not ours. Before this child writes, capture must NOT return the earlier session's
      // content -- it falls back to the raw buffer.
      const capture = new OutputCapture({ commandName: "claude", cwd, home });
      capture.feed(enc("this session's raw buffer"));
      expect(capture.recent()).toBe("this session's raw buffer");
      // Once THIS session writes its own transcript (a new file absent from the launch
      // snapshot), capture uses it.
      writeFileSync(
        join(dir, "this-session.jsonl"),
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "this session reply" }] } })}\n`,
      );
      expect(capture.recent()).toBe("this session reply");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("recent() ignores a pre-existing transcript updated by a concurrent session after launch", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-morph-capture-concurrent-"));
    try {
      const cwd = "/work/proj";
      const dir = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(dir, { recursive: true });
      const other = join(dir, "other-session.jsonl");
      writeFileSync(
        other,
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "other session v1" }] } })}\n`,
      );
      // We launch with that transcript already present (it is in our snapshot).
      const capture = new OutputCapture({ commandName: "claude", cwd, home });
      capture.feed(enc("our raw buffer"));
      // A concurrent session appends to its own pre-existing transcript after we launched.
      writeFileSync(
        other,
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "other session v2" }] } })}\n`,
      );
      // It is still in our launch snapshot, so it is not ours -- we must not capture it.
      expect(capture.recent()).toBe("our raw buffer");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("latestMessages/recent read only a bounded tail of a large transcript", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-morph-capture-tail-"));
    try {
      const cwd = "/work/proj";
      const dir = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(dir, { recursive: true });
      const early = JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "EARLY beyond the tail" }] },
      });
      const late = JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "LATE reply" }] },
      });
      const capture = new OutputCapture({
        commandName: "claude",
        cwd,
        home,
        capBytes: 1_000_000,
        readCapBytes: 500,
      });
      // A long non-JSON filler line (skipped by the parser) pushes `early` out of a small
      // read window; only the tail (the filler remnant + `late`) is read.
      writeFileSync(join(dir, "big.jsonl"), `${early}\n${"#".repeat(2000)}\n${late}\n`);
      const texts = capture.latestMessages(0).map((message) => message.text);
      expect(texts).toContain("LATE reply");
      expect(texts).not.toContain("EARLY beyond the tail");
      expect(capture.recent()).toBe("LATE reply");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("adapterFor", () => {
  test("resolves the known agent identities (including the codex-cli alias)", () => {
    expect(adapterFor("claude")?.names).toContain("claude");
    expect(adapterFor("codex")?.names).toContain("codex");
    // codex-cli maps to the same adapter as codex.
    expect(adapterFor("codex-cli")).toBe(adapterFor("codex"));
    // Each adapter carries its own resume grammar.
    expect(adapterFor("claude")?.detectResume(["--continue"])).toEqual({
      resume: true,
      sessionId: null,
      latest: true,
    });
    expect(adapterFor("codex")?.detectResume(["resume", "--last"])).toEqual({
      resume: true,
      sessionId: null,
      latest: true,
    });
  });

  test("returns null for an unknown program (no transcript adapter)", () => {
    expect(adapterFor("vim")).toBeNull();
    expect(adapterFor("bash")).toBeNull();
    expect(adapterFor("")).toBeNull();
  });
});

describe("Codex SQLite thread index (state_5.sqlite)", () => {
  type Row = {
    id: string;
    rollout_path: string;
    cwd: string;
    source?: string;
    archived?: number;
    recency_at_ms: number;
  };

  // Write a real rollout file under <home>/.codex/sessions/2026/07/31 and return its path.
  const seedRollout = (
    home: string,
    name: string,
    cwd: string,
    id: string,
    text: string,
  ): string => {
    const dir = join(home, ".codex", "sessions", "2026", "07", "31");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-2026-07-31T00-00-00-${name}.jsonl`);
    const meta = JSON.stringify({ type: "session_meta", payload: { cwd, session_id: id } });
    const msg = JSON.stringify({
      payload: { type: "message", role: "assistant", content: [{ type: "text", text }] },
    });
    writeFileSync(path, `${meta}\n${msg}\n`);
    return path;
  };

  // Create a state_5.sqlite whose `threads` table matches the observed Codex schema.
  const seedIndex = (home: string, rows: Row[], dbName = "state_5.sqlite"): void => {
    const dir = join(home, ".codex");
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, dbName), { create: true });
    db.run(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, source TEXT, archived INTEGER, recency_at_ms INTEGER)",
    );
    const insert = db.prepare(
      "INSERT INTO threads (id, rollout_path, cwd, source, archived, recency_at_ms) VALUES ($id, $rp, $cwd, $source, $archived, $rec)",
    );
    for (const r of rows) {
      insert.run({
        $id: r.id,
        $rp: r.rollout_path,
        $cwd: r.cwd,
        $source: r.source ?? "cli",
        $archived: r.archived ?? 0,
        $rec: r.recency_at_ms,
      });
    }
    db.close();
  };

  const withHome = (fn: (home: string) => void): void => {
    const home = mkdtempSync(join(tmpdir(), "ccc-morph-codex-idx-"));
    try {
      fn(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };

  const codex = (home: string, opts: { resumeLatest?: boolean; resumeSessionId?: string }) =>
    new OutputCapture({ commandName: "codex", cwd: "/work/proj", home, ...opts });

  test("resume --last uses the newest unarchived cli row for the exact cwd", () => {
    withHome((home) => {
      const cwd = "/work/proj";
      const target = seedRollout(home, "target", cwd, "id-target", "indexed reply");
      const otherCwd = seedRollout(home, "othercwd", "/elsewhere", "id-other", "other cwd reply");
      const execRow = seedRollout(home, "exec", cwd, "id-exec", "exec reply");
      seedIndex(home, [
        { id: "id-target", rollout_path: target, cwd, recency_at_ms: 100 },
        { id: "id-other", rollout_path: otherCwd, cwd: "/elsewhere", recency_at_ms: 300 },
        { id: "id-exec", rollout_path: execRow, cwd, source: "exec", recency_at_ms: 400 },
      ]);
      const capture = codex(home, { resumeLatest: true });
      capture.feed(enc("raw buffer"));
      // Newer other-cwd and newer exec rows are excluded; the cli row for our cwd wins.
      expect(capture.recent()).toBe("indexed reply");
    });
  });

  test("the indexed path is actually used: SQLite recency wins even when rollout mtimes disagree", () => {
    withHome((home) => {
      const cwd = "/work/proj";
      // Two cli rows for our cwd. The DB says `winner` is newer, but on disk `loser` has the newer
      // mtime -- so a scan would pick `loser`; the index must pick `winner`.
      const winner = seedRollout(home, "winner", cwd, "id-winner", "winner reply");
      const loser = seedRollout(home, "loser", cwd, "id-loser", "loser reply");
      utimesSync(winner, new Date(1000), new Date(1000)); // older on disk
      utimesSync(loser, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000)); // newer on disk
      seedIndex(home, [
        { id: "id-winner", rollout_path: winner, cwd, recency_at_ms: 999 },
        { id: "id-loser", rollout_path: loser, cwd, recency_at_ms: 1 },
      ]);
      expect(codex(home, { resumeLatest: true }).recent()).toBe("winner reply");
    });
  });

  test("an index hit never invokes the recursive collector (resume --last and resume <id>)", () => {
    withHome((home) => {
      const cwd = "/work/proj";
      const latest = seedRollout(home, "latest", cwd, "id-latest", "latest reply");
      const byId = seedRollout(home, "byid", cwd, "id-exact", "byid reply");
      seedIndex(home, [
        { id: "id-latest", rollout_path: latest, cwd, recency_at_ms: 100 },
        { id: "id-exact", rollout_path: byId, cwd, recency_at_ms: 50 },
      ]);
      let scans = 0;
      const collect = (): { path: string; mtimeMs: number }[] => {
        scans += 1;
        return [];
      };
      const last = new OutputCapture({
        commandName: "codex",
        cwd,
        home,
        resumeLatest: true,
        collect,
      });
      expect(last.recent()).toBe("latest reply");
      const exact = new OutputCapture({
        commandName: "codex",
        cwd,
        home,
        resumeSessionId: "id-exact",
        collect,
      });
      expect(exact.recent()).toBe("byid reply");
      // Both resolved from the index; the recursive rollout-tree collector was never called.
      expect(scans).toBe(0);
    });
  });

  test("a fallback (no database) invokes the recursive collector", () => {
    withHome((home) => {
      const cwd = "/work/proj";
      seedRollout(home, "only", cwd, "id-only", "scanned reply");
      let scans = 0;
      const collect = (): { path: string; mtimeMs: number }[] => {
        scans += 1;
        return [];
      };
      // No state_5.sqlite -> the index misses -> the scan fallback runs the collector.
      new OutputCapture({ commandName: "codex", cwd, home, resumeLatest: true, collect });
      expect(scans).toBeGreaterThan(0);
    });
  });

  test("resume <id> uses the exact primary-key row, never a substring", () => {
    withHome((home) => {
      const cwd = "/work/proj";
      const exact = seedRollout(home, "exact", cwd, "abc", "exact reply");
      const decoy = seedRollout(home, "decoy", cwd, "abc123", "decoy reply");
      seedIndex(home, [
        { id: "abc", rollout_path: exact, cwd, recency_at_ms: 1 },
        { id: "abc123", rollout_path: decoy, cwd, recency_at_ms: 999 },
      ]);
      expect(codex(home, { resumeSessionId: "abc" }).recent()).toBe("exact reply");
    });
  });

  test("CODEX_HOME redirects both the database and the sessions-root validation", () => {
    withHome((home) => {
      const prev = process.env.CODEX_HOME;
      process.env.CODEX_HOME = join(home, ".codex");
      try {
        const cwd = "/work/proj";
        const target = seedRollout(home, "t", cwd, "id-t", "redirected reply");
        seedIndex(home, [{ id: "id-t", rollout_path: target, cwd, recency_at_ms: 5 }]);
        // home points elsewhere so only CODEX_HOME can locate the db + rollout.
        const capture = new OutputCapture({
          commandName: "codex",
          cwd,
          home: "/nonexistent-home",
          resumeLatest: true,
        });
        capture.feed(enc("raw buffer"));
        expect(capture.recent()).toBe("redirected reply");
      } finally {
        if (prev === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = prev;
      }
    });
  });

  test("a database-selected resume target stays selected even if a newer rollout appears after launch", () => {
    withHome((home) => {
      const cwd = "/work/proj";
      const target = seedRollout(home, "target", cwd, "id-target", "pinned reply");
      seedIndex(home, [{ id: "id-target", rollout_path: target, cwd, recency_at_ms: 100 }]);
      const capture = codex(home, { resumeLatest: true });
      capture.feed(enc("raw buffer"));
      expect(capture.recent()).toBe("pinned reply");
      // A concurrent session creates a newer same-cwd rollout after launch: must not override.
      const decoy = seedRollout(home, "decoy", cwd, "id-decoy", "decoy reply");
      utimesSync(decoy, new Date(Date.now() + 20_000), new Date(Date.now() + 20_000));
      expect(capture.recent()).toBe("pinned reply");
    });
  });

  test("if the pinned rollout disappears before capture, recent() is the raw buffer and history is empty", () => {
    withHome((home) => {
      const cwd = "/work/proj";
      const target = seedRollout(home, "target", cwd, "id-target", "pinned reply");
      seedIndex(home, [{ id: "id-target", rollout_path: target, cwd, recency_at_ms: 100 }]);
      const capture = codex(home, { resumeLatest: true });
      capture.feed(enc("raw buffer only"));
      expect(capture.recent()).toBe("pinned reply");
      rmSync(target, { force: true });
      expect(capture.recent()).toBe("raw buffer only");
      expect(capture.latestMessages(0)).toEqual([]);
    });
  });

  test("SQLite-first avoids the scan's 40-candidate limit: target found among many other-cwd rollouts", () => {
    withHome((home) => {
      const cwd = "/work/proj";
      // 45 newer rollouts for OTHER cwds (a scan capped at 40 could miss our cwd match entirely).
      for (let i = 0; i < 45; i += 1) {
        const p = seedRollout(home, `noise-${i}`, `/other/${i}`, `noise-${i}`, `noise ${i}`);
        utimesSync(p, new Date(Date.now() + 60_000 + i), new Date(Date.now() + 60_000 + i));
      }
      const target = seedRollout(home, "target", cwd, "id-target", "target reply");
      utimesSync(target, new Date(1000), new Date(1000)); // oldest on disk
      seedIndex(home, [{ id: "id-target", rollout_path: target, cwd, recency_at_ms: 500 }]);
      expect(codex(home, { resumeLatest: true }).recent()).toBe("target reply");
    });
  });

  describe("falls back to the JSONL scan when the index is unusable", () => {
    const expectScanResult = (setup: (home: string, cwd: string, scanTarget: string) => void) =>
      withHome((home) => {
        const cwd = "/work/proj";
        // A valid pre-existing rollout the scan can always find.
        const scanTarget = seedRollout(home, "scan", cwd, "id-scan", "scanned reply");
        setup(home, cwd, scanTarget);
        // Make the scan-target the newest same-cwd rollout so the scan's fallback result is
        // deterministic even when a case also seeds another (rejected) same-cwd rollout.
        utimesSync(scanTarget, new Date(Date.now() + 100_000), new Date(Date.now() + 100_000));
        expect(codex(home, { resumeLatest: true }).recent()).toBe("scanned reply");
      });

    test("missing database", () => {
      expectScanResult(() => {
        /* no index at all */
      });
    });

    test("missing threads table", () => {
      expectScanResult((home) => {
        const db = new Database(join(home, ".codex", "state_5.sqlite"), { create: true });
        db.run("CREATE TABLE unrelated (x INTEGER)");
        db.close();
      });
    });

    test("incompatible schema (missing required column)", () => {
      expectScanResult((home) => {
        const db = new Database(join(home, ".codex", "state_5.sqlite"), { create: true });
        db.run("CREATE TABLE threads (id TEXT, rollout_path TEXT)"); // no cwd/source/archived/recency
        db.close();
      });
    });

    test("invalid SQLite bytes", () => {
      expectScanResult((home) => {
        mkdirSync(join(home, ".codex"), { recursive: true });
        writeFileSync(join(home, ".codex", "state_5.sqlite"), "not a database");
      });
    });

    test("a higher-numbered state_<N>.sqlite is present", () => {
      expectScanResult((home, cwd) => {
        const other = seedRollout(home, "idx", cwd, "id-idx", "indexed reply");
        seedIndex(home, [{ id: "id-idx", rollout_path: other, cwd, recency_at_ms: 999 }]);
        // A newer schema version we don't understand: distrust the v5 db entirely.
        seedIndex(
          home,
          [{ id: "id-idx", rollout_path: other, cwd, recency_at_ms: 999 }],
          "state_6.sqlite",
        );
      });
    });

    test("indexed row points at a missing rollout", () => {
      expectScanResult((home, cwd) => {
        seedIndex(home, [
          {
            id: "id-gone",
            rollout_path: join(home, ".codex", "sessions", "gone.jsonl"),
            cwd,
            recency_at_ms: 999,
          },
        ]);
      });
    });

    test("indexed path escapes the sessions root", () => {
      expectScanResult((home, cwd) => {
        const outside = join(home, "outside-rollout-x.jsonl");
        writeFileSync(
          outside,
          `${JSON.stringify({ type: "session_meta", payload: { cwd, session_id: "id-out" } })}\n`,
        );
        seedIndex(home, [{ id: "id-out", rollout_path: outside, cwd, recency_at_ms: 999 }]);
      });
    });

    test("indexed rollout is a symlink", () => {
      expectScanResult((home, cwd) => {
        const real = seedRollout(home, "real", cwd, "id-link", "linked reply");
        const link = join(
          home,
          ".codex",
          "sessions",
          "2026",
          "07",
          "31",
          "rollout-2026-07-31T00-00-00-link.jsonl",
        );
        symlinkSync(real, link);
        seedIndex(home, [{ id: "id-link", rollout_path: link, cwd, recency_at_ms: 999 }]);
      });
    });

    test("indexed path escapes the sessions tree via a symlinked parent directory", () => {
      expectScanResult((home, cwd) => {
        // A valid rollout that physically lives OUTSIDE the sessions tree.
        const outsideDir = join(home, "outside");
        mkdirSync(outsideDir, { recursive: true });
        const name = "rollout-2026-07-31T00-00-00-esc.jsonl";
        writeFileSync(
          join(outsideDir, name),
          `${JSON.stringify({ type: "session_meta", payload: { cwd, session_id: "id-esc" } })}\n`,
        );
        // A directory *under* sessions that symlinks to the outside dir.
        const parent = join(home, ".codex", "sessions", "2026", "07");
        mkdirSync(parent, { recursive: true });
        symlinkSync(outsideDir, join(parent, "linkdir"));
        // The index points at a path lexically under sessions but really outside via the symlink;
        // canonicalizing parent components must reject it (a lexical prefix check would not).
        seedIndex(home, [
          { id: "id-esc", rollout_path: join(parent, "linkdir", name), cwd, recency_at_ms: 999 },
        ]);
      });
    });

    test("row id disagrees with the rollout's session_meta", () => {
      expectScanResult((home, cwd) => {
        const p = seedRollout(home, "mismatch", cwd, "actual-id", "reply");
        seedIndex(home, [{ id: "claimed-id", rollout_path: p, cwd, recency_at_ms: 999 }]);
      });
    });

    test("row cwd disagrees with the rollout's session_meta", () => {
      expectScanResult((home, cwd) => {
        const p = seedRollout(home, "cwdmiss", "/actual/cwd", "id-cwd", "reply");
        // Index claims it is for our cwd, but the rollout's session_meta says otherwise.
        seedIndex(home, [{ id: "id-cwd", rollout_path: p, cwd, recency_at_ms: 999 }]);
      });
    });

    test("no matching row even though the scan can find one", () => {
      expectScanResult((home) => {
        // An index that simply has no row for our cwd.
        seedIndex(home, [
          { id: "id-none", rollout_path: "/nope.jsonl", cwd: "/other", recency_at_ms: 999 },
        ]);
      });
    });
  });
});
