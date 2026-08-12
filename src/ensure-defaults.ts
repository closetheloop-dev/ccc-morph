import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { parseConfigText } from "./config";
import { bytesKey, encodeKeys } from "./keys";
import type { SessionConfig } from "./types";

export type DefaultBinding = {
  keys: string[];
  actionType: string;
  comment: string;
};

// The default bindings the installer ensures exist. To ship a new default, add one
// entry here — ensureDefaults() adds it only when its action is not already bound and
// its keys are free, leaving the rest of the user's config untouched.
export const DEFAULT_BINDINGS: readonly DefaultBinding[] = [
  {
    keys: ["ctrl-b", "e"],
    actionType: "show-errors",
    comment: "Ctrl-B E opens the error viewer for failed background commands.",
  },
  {
    keys: ["ctrl-b", "n"],
    actionType: "show-notes",
    comment: "Ctrl-B N opens the notes hub (in it: a add, c capture output, e edit).",
  },
];

export type SkipReason = "action-bound" | "keys-in-use";

export type EnsureResult = {
  path: string;
  created: boolean;
  added: DefaultBinding[];
  skipped: { binding: DefaultBinding; reason: SkipReason }[];
  error?: string;
};

function renderBinding(binding: DefaultBinding): string {
  return `\n# ${binding.comment}\n[[bindings]]\nkeys = ${JSON.stringify(binding.keys)}\naction = { type = ${JSON.stringify(binding.actionType)} }\n`;
}

function failure(path: string, error: string): EnsureResult {
  return { path, created: false, added: [], skipped: [], error };
}

// Ensure the default bindings exist in the global config at `configPath`. Detection
// uses ccc-morph's own parser and key encoding (so byte-equivalent duplicates are
// caught), and additions are appended as text so the user's comments and formatting
// are preserved. The file is only written when it would still parse.
export function ensureDefaults(configPath: string): EnsureResult {
  const created = !existsSync(configPath);
  let text: string;
  if (created) {
    text = "version = 1\n";
  } else {
    try {
      text = readFileSync(configPath, "utf8");
    } catch (error) {
      return failure(
        configPath,
        `cannot read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  let existing: SessionConfig;
  try {
    existing = parseConfigText(text, configPath);
  } catch (error) {
    return failure(configPath, error instanceof Error ? error.message : String(error));
  }

  const boundActions = new Set<string>(existing.bindings.map((binding) => binding.action.type));
  const usedKeys = new Set<string>(
    existing.bindings.map((binding) => bytesKey(encodeKeys(binding.keys))),
  );

  const added: DefaultBinding[] = [];
  const skipped: { binding: DefaultBinding; reason: SkipReason }[] = [];
  let next = text;
  for (const binding of DEFAULT_BINDINGS) {
    if (boundActions.has(binding.actionType)) {
      skipped.push({ binding, reason: "action-bound" });
      continue;
    }
    const encoded = bytesKey(encodeKeys(binding.keys));
    if (usedKeys.has(encoded)) {
      skipped.push({ binding, reason: "keys-in-use" });
      continue;
    }
    next += renderBinding(binding);
    added.push(binding);
    // Record so two defaults can never collide with each other in one pass.
    boundActions.add(binding.actionType);
    usedKeys.add(encoded);
  }

  if (added.length === 0 && !created) {
    return { path: configPath, created: false, added, skipped };
  }

  // Final guard: never write something that would not parse.
  try {
    parseConfigText(next, configPath);
  } catch (error) {
    return failure(
      configPath,
      `refusing to write an invalid config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Write through a symlinked config to its target (so a dotfiles symlink is
  // preserved, not replaced by a regular file) and keep the existing file's
  // permissions rather than forcing 0644 (which would widen a private 0600 config).
  // A missing path (or a broken symlink) becomes a fresh 0644 file at configPath.
  // Resolution runs inside the try so a race or permission error is reported, not thrown.
  let temp: string | null = null;
  try {
    let target = configPath;
    let mode = 0o644;
    if (existsSync(configPath)) {
      target = realpathSync(configPath);
      mode = statSync(target).mode & 0o777;
    }
    mkdirSync(dirname(target), { recursive: true });
    temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, next, { mode });
    renameSync(temp, target);
    chmodSync(target, mode);
  } catch (error) {
    if (temp !== null) rmSync(temp, { force: true });
    return failure(
      configPath,
      `cannot write ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { path: configPath, created, added, skipped };
}
