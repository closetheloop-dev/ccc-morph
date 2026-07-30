import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfigText } from "../src/config";
import { DEFAULT_BINDINGS, ensureDefaults } from "../src/ensure-defaults";

function tempConfig(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ccc-morph-ensure-test-"));
  return { dir, path: join(dir, "config.toml") };
}

const actionTypes = (text: string) => parseConfigText(text).bindings.map((b) => b.action.type);

describe("ensure defaults", () => {
  test("creates a fresh config with every default", () => {
    const { dir, path } = tempConfig();
    try {
      const result = ensureDefaults(path);
      expect(result.created).toBe(true);
      expect(result.error).toBeUndefined();
      expect(statSync(path).mode & 0o777).toBe(0o644); // a brand-new config is 0644
      expect(result.added).toHaveLength(DEFAULT_BINDINGS.length);
      const text = readFileSync(path, "utf8");
      // The two-key hub: errors on Ctrl-B E, the notes hub on Ctrl-B N.
      expect(actionTypes(text)).toEqual(["show-errors", "show-notes"]);
      const hub = parseConfigText(text).bindings.find((b) => b.action.type === "show-notes");
      expect(hub?.keys).toEqual(["ctrl-b", "n"]);
      expect(() => parseConfigText(text)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("upgrades an old config that only had ctrl-b e", () => {
    const { dir, path } = tempConfig();
    try {
      writeFileSync(
        path,
        `version = 1
[[bindings]]
keys = ["ctrl-b", "e"]
action = { type = "show-errors" }
`,
      );
      const result = ensureDefaults(path);
      expect(result.created).toBe(false);
      expect(result.added.map((b) => b.actionType)).toEqual(["show-notes"]);
      // show-errors is already present, so it is skipped, not duplicated.
      expect(result.skipped.map((s) => s.reason)).toEqual(["action-bound"]);
      expect(actionTypes(readFileSync(path, "utf8"))).toEqual(["show-errors", "show-notes"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves user comments and custom bindings byte-for-byte", () => {
    const { dir, path } = tempConfig();
    try {
      const original = `version = 1

# my own leader remap — keep this!
[[bindings]]
keys = ["ctrl-b", "l"]
action = { type = "send", keys = ["ctrl-l"] }

[[bindings]]
keys = ["ctrl-b", "e"]
action = { type = "show-errors" }
`;
      writeFileSync(path, original);
      ensureDefaults(path);
      const text = readFileSync(path, "utf8");
      expect(text.startsWith(original)).toBe(true); // original kept verbatim as a prefix
      expect(text).toContain("# my own leader remap — keep this!");
      expect(actionTypes(text)).toEqual(["send", "show-errors", "show-notes"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is idempotent: a second run leaves the file byte-identical", () => {
    const { dir, path } = tempConfig();
    try {
      ensureDefaults(path);
      const first = readFileSync(path, "utf8");
      const result = ensureDefaults(path);
      expect(result.added).toEqual([]);
      expect(readFileSync(path, "utf8")).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips a default whose action is already bound to a different key", () => {
    const { dir, path } = tempConfig();
    try {
      // show-notes already lives on a custom key, so the Ctrl-B N default is skipped.
      writeFileSync(
        path,
        `version = 1
[[bindings]]
keys = ["ctrl-b", "m"]
action = { type = "show-notes" }
`,
      );
      const result = ensureDefaults(path);
      expect(result.added.map((b) => b.actionType)).toEqual(["show-errors"]);
      expect(result.skipped.map((s) => [s.binding.actionType, s.reason])).toEqual([
        ["show-notes", "action-bound"],
      ]);
      const text = readFileSync(path, "utf8");
      expect(actionTypes(text).filter((t) => t === "show-notes")).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips a default whose keys are taken, keeping the config valid", () => {
    const { dir, path } = tempConfig();
    try {
      writeFileSync(
        path,
        `version = 1
[[bindings]]
keys = ["ctrl-b", "n"]
action = { type = "quit" }
`,
      );
      const result = ensureDefaults(path);
      expect(result.skipped.map((s) => [s.binding.actionType, s.reason])).toEqual([
        ["show-notes", "keys-in-use"],
      ]);
      const text = readFileSync(path, "utf8");
      expect(() => parseConfigText(text)).not.toThrow();
      expect(text).toContain(`action = { type = "quit" }`); // user binding untouched
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("detects a byte-equivalent binding via hex (what grep could not)", () => {
    const { dir, path } = tempConfig();
    try {
      // hex:026e == Ctrl-B (0x02) + n (0x6e): the same bytes as ["ctrl-b", "n"].
      writeFileSync(
        path,
        `version = 1
[[bindings]]
keys = ["hex:026e"]
action = { type = "quit" }
`,
      );
      const result = ensureDefaults(path);
      expect(result.skipped.map((s) => [s.binding.actionType, s.reason])).toContainEqual([
        "show-notes",
        "keys-in-use",
      ]);
      expect(() => parseConfigText(readFileSync(path, "utf8"))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses to touch an already-invalid config", () => {
    const { dir, path } = tempConfig();
    try {
      const broken = "version = 1\n[[bindings]\nbroken";
      writeFileSync(path, broken);
      const result = ensureDefaults(path);
      expect(result.error).toBeDefined();
      expect(result.added).toEqual([]);
      expect(readFileSync(path, "utf8")).toBe(broken);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves the permissions of an existing private config", () => {
    const { dir, path } = tempConfig();
    try {
      writeFileSync(path, "version = 1\n");
      chmodSync(path, 0o600);
      const result = ensureDefaults(path);
      expect(result.added.length).toBeGreaterThan(0); // it rewrote the file to add defaults
      expect(statSync(path).mode & 0o777).toBe(0o600); // not widened to 0644
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writes through a symlinked config instead of replacing the link", () => {
    const { dir } = tempConfig();
    try {
      const real = join(dir, "real.toml");
      const link = join(dir, "linked.toml");
      writeFileSync(real, "version = 1\n");
      chmodSync(real, 0o600);
      symlinkSync(real, link);
      const result = ensureDefaults(link);
      expect(result.added.length).toBeGreaterThan(0);
      expect(lstatSync(link).isSymbolicLink()).toBe(true); // link preserved, not clobbered
      expect(readFileSync(real, "utf8")).toContain("show-notes"); // defaults landed in the target
      expect(statSync(real).mode & 0o777).toBe(0o600); // target's mode preserved
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
