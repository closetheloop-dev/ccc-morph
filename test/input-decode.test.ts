import { describe, expect, test } from "bun:test";
import { InputDecoder } from "../src/input-decode";
import { bytesKey, type InputToken, keyId } from "../src/keys";

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

// Summarize a token as "id" for a key or "raw:<hex>" for a passthrough run.
function summarize(token: InputToken): string {
  return token.kind === "key" ? keyId(token.key) : `raw:${bytesKey(token.raw)}`;
}

describe("InputDecoder", () => {
  test("decodes legacy and CSI-u keys, and passes non-keys through raw", () => {
    const d = new InputDecoder();
    const tokens = d.feed(bytes("a\x04\x1b[A\x1b[100;5u\x1b[<0;1;1M"));
    expect(tokens.map(summarize)).toEqual([
      "a",
      "ctrl+d",
      "up",
      "ctrl+d",
      `raw:${bytesKey(bytes("\x1b[<0;1;1M"))}`,
    ]);
  });

  test("reassembles a key split across feeds", () => {
    const d = new InputDecoder();
    expect(d.feed(bytes("\x1b[100"))).toEqual([]); // incomplete
    expect(d.hasPending()).toBe(true);
    const tokens = d.feed(bytes(";5u"));
    expect(tokens.map(summarize)).toEqual(["ctrl+d"]);
    expect(d.hasPending()).toBe(false);
  });

  test("each token's raw is exactly the bytes it consumed (forward-preservation)", () => {
    const d = new InputDecoder();
    const tokens = d.feed(bytes("\x1b[100;5u"));
    expect(tokens).toHaveLength(1);
    expect(bytesKey(tokens[0]!.raw)).toBe(bytesKey(bytes("\x1b[100;5u")));
  });

  test("flush resolves a lone ESC to Escape and a truncated sequence to raw", () => {
    const esc = new InputDecoder();
    expect(esc.feed(bytes("\x1b"))).toEqual([]);
    const flushed = esc.flush();
    expect(flushed.map(summarize)).toEqual(["escape"]);

    const partial = new InputDecoder();
    partial.feed(bytes("\x1b[10"));
    expect(partial.flush().map(summarize)).toEqual([`raw:${bytesKey(bytes("\x1b[10"))}`]);
  });
});
