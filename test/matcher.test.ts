import { describe, expect, test } from "bun:test";
import { InputRouter, ShortcutMatcher } from "../src/matcher";
import type { CompiledBinding } from "../src/types";

function binding(pattern: number[], label = "test"): CompiledBinding {
  return {
    id: label,
    label,
    keys: [],
    pattern: Uint8Array.from(pattern),
    action: { type: "quit" },
  };
}

function flattened(chunks: Uint8Array[]): number[] {
  return chunks.flatMap((chunk) => Array.from(chunk));
}

describe("shortcut matcher", () => {
  test("collapses a completed two-key sequence", () => {
    const output: Uint8Array[] = [];
    const matches: string[] = [];
    const matcher = new ShortcutMatcher(
      [binding([4, 4], "double")],
      20,
      (bytes) => output.push(bytes),
      (match) => matches.push(match.label),
    );

    matcher.feed(Uint8Array.of(4));
    expect(output).toHaveLength(0);
    matcher.feed(Uint8Array.of(4));
    expect(matches).toEqual(["double"]);
    expect(output).toHaveLength(0);
  });

  test("forwards an incomplete sequence after its timeout", async () => {
    const output: Uint8Array[] = [];
    const matcher = new ShortcutMatcher(
      [binding([4, 4])],
      10,
      (bytes) => output.push(bytes),
      () => {},
    );
    matcher.feed(Uint8Array.of(4));
    await Bun.sleep(25);
    expect(flattened(output)).toEqual([4]);
  });

  test("uses a shorter exact binding when a longer binding times out or mismatches", async () => {
    const output: Uint8Array[] = [];
    const matches: string[] = [];
    const matcher = new ShortcutMatcher(
      [binding([4], "single"), binding([4, 4], "double")],
      10,
      (bytes) => output.push(bytes),
      (match) => matches.push(match.label),
    );

    matcher.feed(Uint8Array.of(4));
    await Bun.sleep(25);
    expect(matches).toEqual(["single"]);
    expect(output).toHaveLength(0);

    matcher.feed(Uint8Array.of(4, 120));
    expect(matches).toEqual(["single", "single"]);
    expect(flattened(output)).toEqual([120]);

    matcher.feed(Uint8Array.of(4, 4));
    expect(matches).toEqual(["single", "single", "double"]);
    expect(flattened(output)).toEqual([120]);
  });

  test("settles an exact pending binding when flushed", () => {
    const output: Uint8Array[] = [];
    const matches: string[] = [];
    const matcher = new ShortcutMatcher(
      [binding([4], "single"), binding([4, 4], "double")],
      100,
      (bytes) => output.push(bytes),
      (match) => matches.push(match.label),
    );

    matcher.feed(Uint8Array.of(4));
    matcher.flushPending();
    expect(matches).toEqual(["single"]);
    expect(output).toHaveLength(0);
  });

  test("flushes mismatches without losing their following byte", () => {
    const output: Uint8Array[] = [];
    const matcher = new ShortcutMatcher(
      [binding([4, 4])],
      20,
      (bytes) => output.push(bytes),
      () => {},
    );
    matcher.feed(Uint8Array.of(4, 120));
    expect(flattened(output)).toEqual([4, 120]);
  });

  test("never matches inside bracketed paste, including split markers", () => {
    const output: Uint8Array[] = [];
    const matches: string[] = [];
    const matcher = new ShortcutMatcher(
      [binding([4], "ctrl-d")],
      20,
      (bytes) => output.push(bytes),
      (match) => matches.push(match.label),
    );
    const router = new InputRouter(matcher, (bytes) => output.push(bytes), 100);
    router.feed(Uint8Array.from([27, 91, 50]));
    router.feed(Uint8Array.from([48, 48, 126, 4, 27, 91]));
    router.feed(Uint8Array.from([50, 48, 49, 126]));
    router.dispose();

    expect(matches).toEqual([]);
    expect(flattened(output)).toEqual([27, 91, 50, 48, 48, 126, 4, 27, 91, 50, 48, 49, 126]);
  });
});
