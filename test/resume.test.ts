import { describe, expect, test } from "bun:test";
import { detectClaudeResume, detectCodexResume, NO_RESUME } from "../src/resume";

// Per-agent resume grammars. Which agent a wrapped program maps to is the adapter registry's
// job (see adapterFor in output-capture.test.ts); these test each grammar in isolation.

describe("detectClaudeResume", () => {
  test("a plain 'resume' prompt is NOT a resume", () => {
    expect(detectClaudeResume(["resume"])).toEqual(NO_RESUME);
    expect(detectClaudeResume(["please resume the task"])).toEqual(NO_RESUME);
  });

  test("resumes via --continue / --resume options", () => {
    // --continue targets the most recent session, so `latest` is true.
    expect(detectClaudeResume(["--continue"])).toEqual({
      resume: true,
      sessionId: null,
      latest: true,
    });
    // Bare --resume opens the interactive picker: an unknown session, so `latest` is false.
    expect(detectClaudeResume(["--resume"])).toEqual({
      resume: true,
      sessionId: null,
      latest: false,
    });
    expect(detectClaudeResume(["--resume", "abc-123"])).toEqual({
      resume: true,
      sessionId: "abc-123",
      latest: false,
    });
    expect(detectClaudeResume(["--resume=abc-123"])).toEqual({
      resume: true,
      sessionId: "abc-123",
      latest: false,
    });
    // A following option is not a session id, so this is still the picker.
    expect(detectClaudeResume(["--resume", "--verbose"])).toEqual({
      resume: true,
      sessionId: null,
      latest: false,
    });
  });

  test("options end at `--`: a resume token in prompt data does not count", () => {
    expect(detectClaudeResume(["--", "--resume", "x"])).toEqual(NO_RESUME);
  });
});

describe("detectCodexResume", () => {
  test("resumes only when 'resume' is the leading subcommand", () => {
    // Bare `resume` is the interactive picker (unknown session).
    expect(detectCodexResume(["resume"])).toEqual({
      resume: true,
      sessionId: null,
      latest: false,
    });
    // `resume --last` targets the most recent session.
    expect(detectCodexResume(["resume", "--last"])).toEqual({
      resume: true,
      sessionId: null,
      latest: true,
    });
    expect(detectCodexResume(["resume", "sess-9"])).toEqual({
      resume: true,
      sessionId: "sess-9",
      latest: false,
    });
    // 'resume' as a prompt (after an option-less positional prompt) is not the subcommand.
    expect(detectCodexResume(["write a resume"])).toEqual(NO_RESUME);
    expect(detectCodexResume(["--model", "o3", "hello"])).toEqual(NO_RESUME);
  });

  test("options end at `--`: `resume` after it is not the subcommand", () => {
    expect(detectCodexResume(["--", "resume"])).toEqual(NO_RESUME);
  });

  test("conservative: `resume` behind a global option/value is not detected", () => {
    // `o3` is the value of --model, not the subcommand; we do not guess through unknown
    // options, so this safely reports no resume (capture uses the buffer, never a wrong session).
    expect(detectCodexResume(["--model", "o3", "resume", "--last"])).toEqual(NO_RESUME);
  });
});

describe("picker vs continue/latest", () => {
  test("only continue/--last set `latest` (so capture may fall back to a pre-launch transcript)", () => {
    expect(detectClaudeResume(["--continue"]).latest).toBe(true);
    expect(detectClaudeResume(["--resume"]).latest).toBe(false);
    expect(detectCodexResume(["resume", "--last"]).latest).toBe(true);
    expect(detectCodexResume(["resume"]).latest).toBe(false);
  });
});
