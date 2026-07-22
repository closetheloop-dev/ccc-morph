import { describe, expect, test } from "bun:test";
import { bytesKey, encodeKey, encodeKeys, encodeRawHex, NAMED_KEY_ENCODINGS } from "../src/keys";

describe("key encoding", () => {
  test("encodes control, Alt, named, Unicode, and raw keys", () => {
    expect(Array.from(encodeKey("ctrl-d"))).toEqual([4]);
    expect(Array.from(encodeKey("ctrl-]"))).toEqual([29]);
    expect(Array.from(encodeKey("alt-j"))).toEqual([27, 106]);
    expect(Array.from(encodeKey("up"))).toEqual([27, 91, 65]);
    expect(Array.from(encodeKey("shift-tab"))).toEqual([27, 91, 90]);
    expect(Array.from(encodeKey("backtab"))).toEqual([27, 91, 90]);
    expect(Array.from(encodeKey("app-up"))).toEqual([27, 79, 65]);
    expect(new TextDecoder().decode(encodeKey("é"))).toBe("é");
    expect(Array.from(encodeKey("hex:1b 5b:41"))).toEqual([27, 91, 65]);
  });

  test("encodes conventional control aliases", () => {
    expect(Array.from(encodeKey("ctrl-2"))).toEqual([0]);
    expect(Array.from(encodeKey("ctrl-3"))).toEqual([27]);
    expect(Array.from(encodeKey("ctrl-7"))).toEqual([31]);
    expect(Array.from(encodeKey("ctrl-8"))).toEqual([127]);
    expect(Array.from(encodeKey("ctrl-?"))).toEqual([127]);
  });

  test("encodes xterm-style modified navigation and function keys", () => {
    expect(new TextDecoder().decode(encodeKey("shift-up"))).toBe("\x1b[1;2A");
    expect(new TextDecoder().decode(encodeKey("alt-page-down"))).toBe("\x1b[6;3~");
    expect(new TextDecoder().decode(encodeKey("shift-ctrl-left"))).toBe("\x1b[1;6D");
    expect(new TextDecoder().decode(encodeKey("ctrl-alt-f1"))).toBe("\x1b[1;7P");
    expect(new TextDecoder().decode(encodeKey("ctrl-f12"))).toBe("\x1b[24;5~");
  });

  test("keeps the complete named-key vocabulary explicit", () => {
    expect(Object.keys(NAMED_KEY_ENCODINGS)).toEqual([
      "enter",
      "return",
      "tab",
      "shift-tab",
      "backtab",
      "backspace",
      "escape",
      "esc",
      "space",
      "up",
      "down",
      "right",
      "left",
      "home",
      "end",
      "insert",
      "ins",
      "delete",
      "del",
      "page-up",
      "pgup",
      "page-down",
      "pgdn",
      "app-up",
      "app-down",
      "app-right",
      "app-left",
      "app-home",
      "app-end",
      "f1",
      "f2",
      "f3",
      "f4",
      "f5",
      "f6",
      "f7",
      "f8",
      "f9",
      "f10",
      "f11",
      "f12",
    ]);
  });

  test("concatenates key sequences exactly", () => {
    expect(bytesKey(encodeKeys(["ctrl-d", "ctrl-d"]))).toBe("0404");
    expect(Array.from(encodeRawHex("04:1b"))).toEqual([4, 27]);
  });

  test("rejects unknown and malformed keys", () => {
    expect(() => encodeKey("ctrl-not-a-key")).toThrow();
    expect(() => encodeKey("hex:123")).toThrow();
    expect(() => encodeKey("alt-many")).toThrow();
    expect(() => encodeKey("shift-enter")).toThrow();
    expect(() => encodeKey("shift-shift-up")).toThrow();
  });
});
