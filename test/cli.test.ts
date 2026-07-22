import { describe, expect, test } from "bun:test";
import { parseArguments } from "../src/cli";

describe("CLI arguments", () => {
  test("keeps wrapped argv intact", () => {
    const parsed = parseArguments(["--no-config", "--", "codex", "--model", "example"]);
    expect(parsed).toEqual({
      configPath: null,
      configExplicit: false,
      appName: null,
      command: ["codex", "--model", "example"],
    });
  });

  test("passes help and version flags after the separator to the child", () => {
    expect(parseArguments(["--", "codex", "--help"])).toMatchObject({
      command: ["codex", "--help"],
    });
    expect(parseArguments(["--", "tool", "--version"])).toMatchObject({
      command: ["tool", "--version"],
    });
  });

  test("parses an explicit app", () => {
    const parsed = parseArguments(["--app", "codex", "--", "bash"]);
    expect(parsed).toMatchObject({
      configExplicit: false,
      appName: "codex",
      command: ["bash"],
    });
  });

  test("parses the standalone key inspector", () => {
    expect(parseArguments(["--inspect-key"])).toBe("inspect-key");
    expect(() => parseArguments(["--inspect-key", "--", "bash"])).toThrow("cannot be combined");
  });

  test("requires the separator and command", () => {
    expect(() => parseArguments(["codex"])).toThrow("missing --");
    expect(() => parseArguments(["--"])).toThrow("missing wrapped command");
  });

  test("rejects conflicting configuration options", () => {
    expect(() => parseArguments(["--no-config", "--config", "x", "--", "sh"])).toThrow(
      "cannot be combined",
    );
    expect(() => parseArguments(["--app", "codex", "--no-config", "--", "sh"])).toThrow(
      "cannot be combined",
    );
    expect(() => parseArguments(["--no-config", "--app", "codex", "--", "sh"])).toThrow(
      "cannot be combined",
    );
    expect(() => parseArguments(["--config", "x", "--app", "codex", "--", "sh"])).toThrow(
      "cannot be combined",
    );
    expect(() => parseArguments(["--app", "codex", "--config", "x", "--", "sh"])).toThrow(
      "cannot be combined",
    );
  });

  test("rejects missing and repeated app names", () => {
    expect(() => parseArguments(["--app", "--", "sh"])).toThrow("requires an app name");
    expect(() => parseArguments(["--app", "one", "--app", "two", "--", "sh"])).toThrow(
      "only be specified once",
    );
  });
});
