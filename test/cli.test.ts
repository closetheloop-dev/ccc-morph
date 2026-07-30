import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

  test("parses the standalone config checker", () => {
    expect(parseArguments(["--check-config", "cfg.toml"])).toEqual({ checkConfigPath: "cfg.toml" });
    expect(() => parseArguments(["--check-config"])).toThrow("file path");
    expect(() => parseArguments(["--check-config", "cfg.toml", "--", "bash"])).toThrow(
      "no other arguments",
    );
  });

  test("--check-config sets the exit code by validity", async () => {
    const bun = Bun.which("bun");
    if (!bun) throw new Error("Bun executable not found");
    const dir = mkdtempSync(join(tmpdir(), "ccc-morph-check-config-test-"));
    const cli = resolve(import.meta.dir, "../src/cli.ts");
    try {
      const valid = join(dir, "valid.toml");
      writeFileSync(
        valid,
        `version = 1
[[bindings]]
keys = ["ctrl-b", "e"]
action = { type = "show-errors" }
`,
      );
      const ok = Bun.spawn([bun, "run", cli, "--check-config", valid], {
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await ok.exited).toBe(0);

      // Two bindings compiling to the same keys must be rejected.
      const dup = join(dir, "dup.toml");
      writeFileSync(
        dup,
        `version = 1
[[bindings]]
keys = ["ctrl-b", "n"]
action = { type = "add-note" }
[[bindings]]
keys = ["ctrl-b", "n"]
action = { type = "show-notes" }
`,
      );
      const bad = Bun.spawn([bun, "run", cli, "--check-config", dup], {
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await bad.exited).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parses the standalone ensure-defaults", () => {
    expect(parseArguments(["--ensure-defaults"])).toBe("ensure-defaults");
    expect(() => parseArguments(["--ensure-defaults", "--", "bash"])).toThrow("cannot be combined");
  });

  test("--ensure-defaults writes a valid default config under XDG_CONFIG_HOME", async () => {
    const bun = Bun.which("bun");
    if (!bun) throw new Error("Bun executable not found");
    const xdg = mkdtempSync(join(tmpdir(), "ccc-morph-ensure-cli-test-"));
    const cli = resolve(import.meta.dir, "../src/cli.ts");
    try {
      const proc = Bun.spawn([bun, "run", cli, "--ensure-defaults"], {
        env: { ...process.env, XDG_CONFIG_HOME: xdg },
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await proc.exited).toBe(0);

      const configPath = join(xdg, "ccc-morph", "config.toml");
      expect(existsSync(configPath)).toBe(true);
      expect(readFileSync(configPath, "utf8")).toContain('type = "show-notes"');

      const check = Bun.spawn([bun, "run", cli, "--check-config", configPath], {
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await check.exited).toBe(0);
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
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
