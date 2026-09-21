import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Source files must be ordinary text. A literal NUL (0x00) byte turns a file into a
// git-binary blob (no diffs/blame/patching) and can break JS/TS tooling, so guard
// against one ever slipping back into the source or tests.
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("source integrity", () => {
  test("no source or test file contains a NUL byte", () => {
    const root = resolve(import.meta.dir, "..");
    const files = [...tsFiles(join(root, "src")), ...tsFiles(join(root, "test"))];
    const offenders = files.filter((path) => readFileSync(path).includes(0x00));
    expect(offenders).toEqual([]);
  });
});
