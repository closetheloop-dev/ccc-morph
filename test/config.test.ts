import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  compileBindings,
  emptyConfig,
  loadResolvedConfig,
  parseAppConfigText,
  parseConfigText,
} from "../src/config";

const valid = `version = 1
sequence_timeout_ms = 125
max_error_output_bytes = 99
notice_timeout_ms = 222
completion_notice_timeout_ms = 444
start_notice_timeout_ms = 333

[[bindings]]
keys = ["ctrl-d", "ctrl-d"]
action = { type = "send", keys = ["ctrl-d"] }

[[bindings]]
keys = ["ctrl-g", "e"]
action = { type = "show-errors" }

[[bindings]]
keys = ["ctrl-g", "r"]
action = { type = "run", argv = ["sh", "-c", "false"] }
`;

// Writes a global config.toml and an apps/ directory in a fresh temp dir, runs
// `body` with the config path, and cleans up. `apps` maps <name> -> file text.
function withConfig(
  globalText: string,
  apps: Record<string, string>,
  body: (configPath: string) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), "ccc-morph-config-test-"));
  const configPath = join(directory, "config.toml");
  writeFileSync(configPath, globalText);
  const appsDirectory = join(directory, "apps");
  if (Object.keys(apps).length > 0) mkdirSync(appsDirectory);
  for (const [name, text] of Object.entries(apps)) {
    writeFileSync(join(appsDirectory, `${name}.toml`), text);
  }
  try {
    body(configPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("configuration", () => {
  test("parses and compiles the global configuration", () => {
    const config = parseConfigText(valid);
    expect(config.sequenceTimeoutMs).toBe(125);
    expect(config.maxErrorOutputBytes).toBe(99);
    expect(config.noticeTimeoutMs).toBe(222);
    expect(config.completionNoticeTimeoutMs).toBe(444);
    expect(config.startNoticeTimeoutMs).toBe(333);
    expect(config.bindings).toHaveLength(3);
    expect(Array.from(compileBindings(config)[0]!.pattern)).toEqual([4, 4]);
  });

  test("uses transparent defaults", () => {
    expect(emptyConfig().bindings).toEqual([]);
    expect(emptyConfig().sequenceTimeoutMs).toBe(1000);
    expect(emptyConfig().noticeTimeoutMs).toBe(10000);
    expect(emptyConfig().completionNoticeTimeoutMs).toBe(5000);
    expect(emptyConfig().startNoticeTimeoutMs).toBe(3000);
  });

  test("keeps the shipped example configuration valid", () => {
    const text = readFileSync(resolve(import.meta.dir, "../examples/config.toml"), "utf8");
    const config = parseConfigText(text, "examples/config.toml");
    expect(config.bindings.map((binding) => binding.keys)).toEqual([
      ["ctrl-b", "e"],
      ["ctrl-b", "r"],
      ["ctrl-b", "l"],
    ]);
  });

  test("keeps the shipped Codex app config valid", () => {
    const text = readFileSync(resolve(import.meta.dir, "../apps/codex.toml"), "utf8");
    const app = parseAppConfigText(text, "apps/codex.toml");
    expect(app.sequenceTimeoutMs).toBe(1000);
    expect(app.aliases).toEqual(["codex-cli"]);
    expect(app.bindings.map((binding) => binding.action.type)).toEqual(["ignore", "send"]);
  });

  test("discovers an app config by basename and layers it over globals", () => {
    const global = `version = 1
sequence_timeout_ms = 125
notice_timeout_ms = 5000
completion_notice_timeout_ms = 6000
start_notice_timeout_ms = 1000
[[bindings]]
keys = ["ctrl-a"]
action = { type = "quit" }
`;
    const codex = `version = 1
sequence_timeout_ms = 500
notice_timeout_ms = 333
completion_notice_timeout_ms = 777
[[unbind]]
keys = ["ctrl-a"]
[[bindings]]
keys = ["ctrl-b"]
action = { type = "ignore" }
[[bindings]]
keys = ["ctrl-d", "ctrl-d"]
action = { type = "send", keys = ["ctrl-d"] }
`;
    withConfig(global, { codex }, (configPath) => {
      const resolved = loadResolvedConfig(configPath, false, ["codex"], null);
      expect(resolved.appName).toBe("codex");
      expect(resolved.sequenceTimeoutMs).toBe(500);
      expect(resolved.noticeTimeoutMs).toBe(333);
      expect(resolved.completionNoticeTimeoutMs).toBe(777);
      // The app omits start_notice_timeout_ms, so it inherits the global value.
      expect(resolved.startNoticeTimeoutMs).toBe(1000);
      expect(resolved.bindings.map((binding) => binding.keys)).toEqual([
        ["ctrl-b"],
        ["ctrl-d", "ctrl-d"],
      ]);
      expect(resolved.bindings[0]!.action).toEqual({ type: "ignore" });
    });
  });

  test("discovers an app config by alias", () => {
    const codex = `version = 1
aliases = ["codex-cli"]
[[bindings]]
keys = ["ctrl-b"]
action = { type = "ignore" }
`;
    withConfig("version = 1\n", { codex }, (configPath) => {
      const byAlias = loadResolvedConfig(configPath, false, ["/usr/local/bin/codex-cli"], null);
      expect(byAlias.appName).toBe("codex");
      const byBasename = loadResolvedConfig(configPath, false, ["codex"], null);
      expect(byBasename.appName).toBe("codex");
      const unrelated = loadResolvedConfig(configPath, false, ["bash"], null);
      expect(unrelated.appName).toBeNull();
    });
  });

  test("applies an explicit --app config regardless of the wrapped command", () => {
    const codex = `version = 1
inherit_globals = false
[[bindings]]
keys = ["ctrl-d"]
action = { type = "ignore" }
`;
    withConfig("version = 1\n", { codex }, (configPath) => {
      const resolved = loadResolvedConfig(configPath, false, ["bash"], "codex");
      expect(resolved.appName).toBe("codex");
      expect(resolved.bindings).toEqual([{ keys: ["ctrl-d"], action: { type: "ignore" } }]);
    });
  });

  test("--config uses only the given file and ignores app discovery", () => {
    const global = `version = 1
sequence_timeout_ms = 125
[[bindings]]
keys = ["ctrl-a"]
action = { type = "quit" }
`;
    const codex = `version = 1
[[bindings]]
keys = ["ctrl-a"]
action = { type = "ignore" }
`;
    withConfig(global, { codex }, (configPath) => {
      const resolved = loadResolvedConfig(configPath, true, ["codex"], null);
      expect(resolved.appName).toBeNull();
      expect(resolved.sequenceTimeoutMs).toBe(125);
      expect(resolved.bindings.map((binding) => binding.keys)).toEqual([["ctrl-a"]]);
      expect(resolved.bindings[0]!.action).toEqual({ type: "quit" });
    });
  });

  test("errors on an unknown --app name", () => {
    withConfig("version = 1\n", {}, (configPath) => {
      expect(() => loadResolvedConfig(configPath, false, ["bash"], "missing")).toThrow(
        "unknown app config",
      );
    });
  });

  test("rejects a program matching multiple app configs by alias", () => {
    const one = `version = 1
aliases = ["shared"]
[[bindings]]
keys = ["ctrl-a"]
action = { type = "quit" }
`;
    const two = `version = 1
aliases = ["shared"]
[[bindings]]
keys = ["ctrl-b"]
action = { type = "quit" }
`;
    withConfig("version = 1\n", { one, two }, (configPath) => {
      expect(() => loadResolvedConfig(configPath, false, ["shared"], null)).toThrow(
        "matches multiple app configs",
      );
    });
  });

  test("does not discover app configs when configuration is disabled", () => {
    const resolved = loadResolvedConfig(null, false, ["codex"], null);
    expect(resolved.appName).toBeNull();
    expect(resolved.bindings).toEqual([]);
  });

  test("overrides by terminal encoding rather than spelling", () => {
    const global = `version = 1
[[bindings]]
keys = ["alt-x"]
action = { type = "quit" }
`;
    const demo = `version = 1
[[bindings]]
keys = ["escape", "x"]
action = { type = "show-errors" }
`;
    withConfig(global, { demo }, (configPath) => {
      const resolved = loadResolvedConfig(configPath, false, ["demo"], null);
      expect(resolved.bindings).toHaveLength(1);
      expect(resolved.bindings[0]!.action).toEqual({ type: "show-errors" });
    });
  });

  test("validates app config files", () => {
    expect(() =>
      parseAppConfigText(`version = 1
sequence_timeout_ms = 0
`),
    ).toThrow("positive integer");

    expect(() =>
      parseAppConfigText(`version = 1
notice_timeout_ms = 0
`),
    ).toThrow("positive integer");

    expect(() =>
      parseAppConfigText(`version = 1
inherit_globals = false
[[unbind]]
keys = ["ctrl-d"]
`),
    ).toThrow("cannot be used");

    expect(() =>
      parseAppConfigText(`version = 1
aliases = ["/usr/bin/demo"]
`),
    ).toThrow("basename");
  });

  test("rejects duplicate encodings within one binding set", () => {
    expect(() =>
      parseConfigText(`version = 1
[[bindings]]
keys = ["alt-x"]
action = { type = "quit" }
[[bindings]]
keys = ["escape", "x"]
action = { type = "quit" }
`),
    ).toThrow("same terminal encoding");
  });

  test("validates send actions before starting a child", () => {
    expect(() =>
      parseConfigText(`version = 1
[[bindings]]
keys = ["ctrl-a"]
action = { type = "send", keys = ["not-a-key"] }
`),
    ).toThrow("unknown key");
  });
});
