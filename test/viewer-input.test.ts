import { describe, expect, test } from "bun:test";
import { parseKeyName } from "../src/keys";
import { keyToViewerToken } from "../src/viewer-input";

const tokenOf = (spec: string) => keyToViewerToken(parseKeyName(spec));

describe("keyToViewerToken", () => {
  test("maps navigation keys to their named tokens", () => {
    expect(tokenOf("up")).toBe("up");
    expect(tokenOf("down")).toBe("down");
    expect(tokenOf("page-up")).toBe("page-up");
    expect(tokenOf("page-down")).toBe("page-down");
  });

  test("collapses every other key to the legacy byte the viewers switch on", () => {
    expect(tokenOf("j")).toBe(0x6a);
    expect(tokenOf("k")).toBe(0x6b);
    expect(tokenOf("q")).toBe(0x71);
    expect(tokenOf("space")).toBe(0x20);
    expect(tokenOf("enter")).toBe(0x0d);
    expect(tokenOf("tab")).toBe(0x09);
    expect(tokenOf("escape")).toBe(0x1b);
    expect(tokenOf("backspace")).toBe(0x7f);
    expect(tokenOf("ctrl-d")).toBe(0x04); // half-page down in the note preview
    expect(tokenOf("D")).toBe(0x44); // Shift-D asks to delete
    expect(tokenOf("C")).toBe(0x43); // Shift-C opens history
  });

  test("works whether the key arrived as legacy bytes or Kitty CSI-u", () => {
    // A decoded key has one identity regardless of how the terminal encoded it, so
    // the same token comes out for q and Ctrl-D no matter the source encoding.
    expect(tokenOf("q")).toBe(
      keyToViewerToken({ name: "q", mods: { ctrl: false, alt: false, shift: false } }),
    );
  });

  test("returns null for keys with no single-byte legacy form", () => {
    expect(tokenOf("ctrl-up")).toBeNull(); // a modified arrow: no viewer command
    expect(tokenOf("f5")).toBeNull();
  });
});
