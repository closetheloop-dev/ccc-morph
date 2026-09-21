import { describe, expect, test } from "bun:test";
import {
  type ChordElement,
  compileChord,
  decodeLegacyKey,
  type InputToken,
  type KeyEventType,
  keyId,
} from "../src/keys";
import {
  KITTY_REPORT_ALL_KEYS,
  KITTY_REPORT_ALTERNATE_KEYS,
  KITTY_REPORT_EVENT_TYPES,
} from "../src/kitty";
import { InputRouter, ShortcutMatcher } from "../src/matcher";
import type { CompiledBinding } from "../src/types";

const EVENT_FLAGS = KITTY_REPORT_EVENT_TYPES | KITTY_REPORT_ALL_KEYS;
const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function chordBinding(spec: string, label: string): CompiledBinding {
  return { id: label, label, keys: [], chord: compileChord([spec]), action: { type: "quit" } };
}

// Derive the compiled chord for a byte pattern (e.g. [4] -> one accept-set {ctrl+d}).
function chordFor(pattern: number[]): ChordElement[] {
  return pattern.map((byte) => {
    const decoded = decodeLegacyKey(Uint8Array.of(byte));
    const id = decoded && decoded.token.kind === "key" ? keyId(decoded.token.key) : String(byte);
    return { kind: "ids", ids: new Set([id]) };
  });
}

function binding(pattern: number[], label = "test"): CompiledBinding {
  return {
    id: label,
    label,
    keys: [],
    chord: chordFor(pattern),
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
    const router = new InputRouter(
      {
        keys: (tokens) => matcher.feedKeys(tokens),
        paste: (bytes) => output.push(bytes),
        beforePaste: () => matcher.flushPending(),
      },
      100,
    );
    router.feed(Uint8Array.from([27, 91, 50]));
    router.feed(Uint8Array.from([48, 48, 126, 4, 27, 91]));
    router.feed(Uint8Array.from([50, 48, 49, 126]));
    router.dispose();

    expect(matches).toEqual([]);
    expect(flattened(output)).toEqual([27, 91, 50, 48, 48, 126, 4, 27, 91, 50, 48, 49, 126]);
  });
});

const NO_MODS = { ctrl: false, alt: false, shift: false };
const raw = (value: number) => Uint8Array.of(value);
const ctrlD = (event: KeyEventType, value: number): InputToken => ({
  kind: "key",
  key: { name: "d", mods: { ...NO_MODS, ctrl: true } },
  event,
  raw: raw(value),
});
const ctrlB = (event: KeyEventType, value: number): InputToken => ({
  kind: "key",
  key: { name: "b", mods: { ...NO_MODS, ctrl: true } },
  event,
  raw: raw(value),
});
const plain = (name: string, event: KeyEventType, value: number): InputToken => ({
  kind: "key",
  key: { name, mods: { ...NO_MODS } },
  event,
  raw: raw(value),
});
// Under REPORT_ALL_KEYS the terminal reports the modifier keys themselves; left control is
// codepoint 57442. Such a press must be forwarded but must not disturb a pending chord.
const leftCtrl = (event: KeyEventType, value: number): InputToken => ({
  kind: "key",
  key: { name: String.fromCodePoint(57442), mods: { ...NO_MODS, ctrl: true } },
  event,
  raw: raw(value),
});
// A modifier-key release with an explicit Ctrl-bit state: the protocol sets the bit while a
// Control is held and resets it once the last Control is up, so a key's press and release can
// carry different modifier bits.
const modRelease = (codepoint: number, value: number, ctrl: boolean): InputToken => ({
  kind: "key",
  key: { name: String.fromCodePoint(codepoint), mods: { ...NO_MODS, ctrl } },
  event: "release",
  raw: raw(value),
});

// Kitty event-type reporting (flag 2) sends press/repeat/release for each key. Only
// presses drive chords; releases and repeats must neither settle a pending chord nor
// leak orphaned events to the child.
describe("shortcut matcher key-event lifecycle", () => {
  function setup(bindings: CompiledBinding[], timeoutMs = 1000) {
    const output: Uint8Array[] = [];
    const matches: string[] = [];
    const matcher = new ShortcutMatcher(
      bindings,
      timeoutMs,
      (bytes) => output.push(bytes),
      (match) => matches.push(match.label),
    );
    matcher.setFlags(EVENT_FLAGS); // these scenarios simulate Kitty event-type mode
    return { matcher, output, matches };
  }

  test("a release between taps does not settle the chord; the double-tap fires", () => {
    const { matcher, output, matches } = setup([binding([4], "single"), binding([4, 4], "double")]);
    matcher.feedKeys([
      ctrlD("press", 1),
      ctrlD("release", 2),
      ctrlD("press", 3),
      ctrlD("release", 4),
    ]);
    expect(matches).toEqual(["double"]);
    expect(output).toHaveLength(0); // both releases swallowed with their consumed presses
  });

  test("the release of a consumed press is swallowed, never forwarded", () => {
    const { matcher, output, matches } = setup([binding([4], "single")]);
    matcher.feedKeys([ctrlD("press", 1), ctrlD("release", 2)]);
    expect(matches).toEqual(["single"]);
    expect(output).toHaveLength(0);
  });

  test("a modifier key event between taps is forwarded but does not break the double-tap", () => {
    // Real Kitty REPORT_ALL_KEYS terminals report the modifier key itself: when a user
    // releases and re-presses Ctrl between the two taps of a Ctrl-D chord, a Ctrl press
    // event interleaves between the two ctrl-d presses. It must be forwarded verbatim but
    // must NOT cancel the pending double-tap.
    const { matcher, output, matches } = setup([binding([4], "single"), binding([4, 4], "double")]);
    matcher.feedKeys([
      leftCtrl("press", 9),
      ctrlD("press", 1),
      ctrlD("release", 2),
      leftCtrl("press", 9),
      ctrlD("press", 3),
      ctrlD("release", 4),
    ]);
    expect(matches).toEqual(["double"]); // the guard still fires despite the interleaved Ctrl
    expect(flattened(output)).toEqual([9, 9]); // modifier presses forwarded; ctrl-d's consumed
  });

  test("modifier events interleaved in a DIVERGING chord keep original byte order", () => {
    // Only [ctrl-d, ctrl-d] is configured. A first Ctrl-D press/release, then Ctrl released
    // and re-pressed, then an unrelated key that rejects the chord. The modifier lifecycle
    // must NOT be emitted before the Ctrl-D that preceded it: the passed-through bytes come
    // out in exactly their original order.
    const { matcher, output, matches } = setup([binding([4, 4], "double")]);
    matcher.feedKeys([
      ctrlD("press", 1),
      ctrlD("release", 2),
      leftCtrl("release", 9),
      leftCtrl("press", 8),
      plain("x", "press", 88),
      plain("x", "release", 89),
    ]);
    expect(matches).toEqual([]);
    expect(flattened(output)).toEqual([1, 2, 9, 8, 88, 89]);
  });

  test("modifier events interleaved in a TIMED-OUT prefix keep original byte order", async () => {
    const { matcher, output, matches } = setup([binding([4, 4], "double")], 30);
    matcher.feedKeys([ctrlD("press", 1), ctrlD("release", 2), leftCtrl("press", 9)]);
    await Bun.sleep(60); // the lone Ctrl-D prefix times out; nothing matched
    expect(matches).toEqual([]);
    expect(flattened(output)).toEqual([1, 2, 9]); // Ctrl-D press+release, then the modifier
  });

  test("a modifier press consumed in a modal has its release swallowed by physical identity", () => {
    // A modal consumes a left-Control press (the event carries the Ctrl bit). Its release
    // arrives with the Ctrl bit RESET (the only Control is now up), so its ordinary id
    // differs; the debt must still be settled by the modifier's stable physical identity.
    const { matcher, output } = setup([binding([4], "single")]);
    matcher.oweRelease({ name: String.fromCodePoint(57442), mods: { ...NO_MODS, ctrl: true } });
    matcher.feedKeys([modRelease(57442, 9, false)]);
    expect(output).toHaveLength(0); // swallowed, not leaked to the child as an orphan release
  });

  test("overlapping Control keys: each release settles its own debt regardless of the Ctrl bit", () => {
    const { matcher, output } = setup([binding([4], "single")]);
    matcher.oweRelease({ name: String.fromCodePoint(57442), mods: { ...NO_MODS, ctrl: true } }); // left
    matcher.oweRelease({ name: String.fromCodePoint(57448), mods: { ...NO_MODS, ctrl: true } }); // right
    // Release LEFT while RIGHT is still held: the event still carries the Ctrl bit.
    matcher.feedKeys([modRelease(57442, 1, true)]);
    expect(output).toHaveLength(0); // left debt paid by physical (per-key) identity
    // Release RIGHT: now the only Control is up, so the Ctrl bit is reset.
    matcher.feedKeys([modRelease(57448, 2, false)]);
    expect(output).toHaveLength(0); // right debt paid too; no orphan release either time
  });

  test("a modal-consumed modifier's repeats are swallowed while its release settles the debt", () => {
    const ctrlKey = { name: String.fromCodePoint(57442), mods: { ...NO_MODS, ctrl: true } };
    const { matcher, output } = setup([binding([4], "single")]);
    matcher.oweRelease(ctrlKey); // modal consumed a left-Control press
    // Repeats of that held modifier must be swallowed (its press was consumed), like ordinary
    // keys, without settling the debt...
    matcher.feedKeys([
      { kind: "key", key: ctrlKey, event: "repeat", raw: raw(7) },
      { kind: "key", key: ctrlKey, event: "repeat", raw: raw(7) },
    ]);
    expect(output).toHaveLength(0);
    // ...then the release finally settles it, still leaking nothing.
    matcher.feedKeys([modRelease(57442, 9, false)]);
    expect(output).toHaveLength(0);
  });

  test("modifier activity does not restart a pending prefix's deadline", async () => {
    const { matcher, matches } = setup([binding([4], "single"), binding([4, 4], "double")], 30);
    matcher.feedKeys([ctrlD("press", 1)]); // deadline ~30ms from here
    // A stream of modifier events every 10ms, each well inside the window; if any restarted the
    // timer the single would be postponed past its original deadline.
    for (let i = 0; i < 4; i += 1) {
      await Bun.sleep(10);
      matcher.feedKeys([i % 2 === 0 ? leftCtrl("release", 9) : leftCtrl("press", 8)]);
    }
    expect(matches).toEqual(["single"]); // fired at its original ~30ms deadline, not postponed
  });

  test("a trailing modifier suffix is drained promptly after an expiry match", async () => {
    const { matcher, output, matches } = setup(
      [binding([4], "single"), binding([4, 4], "double")],
      30,
    );
    matcher.feedKeys([ctrlD("press", 1), leftCtrl("release", 9), leftCtrl("press", 8)]);
    await Bun.sleep(60); // the single fires on timeout; the trailing modifiers must not be stranded
    expect(matches).toEqual(["single"]);
    expect(flattened(output)).toEqual([9, 8]); // forwarded promptly, not left buffered in #pending
  });

  test("a consumed Ctrl-D whose Ctrl is released before D leaks no orphan release", () => {
    const { matcher, output, matches } = setup([binding([4], "single")]);
    matcher.feedKeys([
      ctrlD("press", 1), // consumed immediately by [ctrl-d]; its release is owed under key:d
      leftCtrl("release", 9), // Ctrl up (no debt for Ctrl itself): forwarded
      { kind: "key", key: { name: "d", mods: { ...NO_MODS } }, event: "release", raw: raw(2) }, // D up, Ctrl bit reset
    ]);
    expect(matches).toEqual(["single"]);
    expect(flattened(output)).toEqual([9]); // D's release settled its ctrl-d debt by physical id
  });

  test("a passed-through Ctrl-D whose Ctrl is released before D is forwarded in exact arrival order", async () => {
    const { matcher, output, matches } = setup([binding([4, 4], "double")], 30);
    matcher.feedKeys([
      ctrlD("press", 1), // held as a [ctrl-d, ctrl-d] prefix
      leftCtrl("release", 9), // Ctrl up: transparent, positioned
      { kind: "key", key: { name: "d", mods: { ...NO_MODS } }, event: "release", raw: raw(2) }, // D up, Ctrl bit reset
    ]);
    await Bun.sleep(60); // prefix times out unmatched -> passed through
    expect(matches).toEqual([]);
    // Exact arrival order: D press, then the Ctrl release, then the D release -- the release is
    // not pulled ahead of the events that arrived between it and its press.
    expect(flattened(output)).toEqual([1, 9, 2]);
  });

  test("a real key event between a held prefix's press and release keeps arrival order", async () => {
    const { matcher, output, matches } = setup([binding([4, 4], "double")], 30);
    matcher.feedKeys([
      ctrlD("press", 1), // held prefix
      plain("x", "press", 88), // an unrelated real key arrives between the press and its release
      plain("x", "release", 89),
      ctrlD("release", 2),
    ]);
    await Bun.sleep(60); // times out unmatched
    expect(matches).toEqual([]);
    // Everything in exact arrival order, independent of modifier transparency.
    expect(flattened(output)).toEqual([1, 88, 89, 2]);
  });

  test("an unmatched key forwards both its press and its release", () => {
    const { matcher, output, matches } = setup([binding([4], "single")]);
    matcher.feedKeys([plain("x", "press", 120), plain("x", "release", 200)]);
    expect(matches).toEqual([]);
    expect(flattened(output)).toEqual([120, 200]);
  });

  test("a repeat never settles a pending chord", () => {
    const { matcher, output, matches } = setup([binding([4, 4], "double")]);
    matcher.feedKeys([ctrlD("press", 1), ctrlD("repeat", 2)]);
    expect(matches).toEqual([]);
    expect(output).toHaveLength(0); // still held, waiting for the second tap
    matcher.feedKeys([ctrlD("press", 3)]);
    expect(matches).toEqual(["double"]);
    expect(output).toHaveLength(0);
  });

  test("an exact-byte chord matches only those bytes, not another encoding", () => {
    // hex:1b5b41 (ESC[A) must match a normal-cursor up, not an application-cursor up.
    const chord: ChordElement[] = [{ kind: "bytes", bytes: Uint8Array.of(0x1b, 0x5b, 0x41) }];
    const { matcher, output, matches } = setup([
      { id: "up", label: "up", keys: [], chord, action: { type: "quit" } },
    ]);
    matcher.feed(Uint8Array.of(0x1b, 0x4f, 0x41)); // ESC O A (application cursor): no match
    expect(matches).toEqual([]);
    expect(flattened(output)).toEqual([0x1b, 0x4f, 0x41]);
    matcher.feed(Uint8Array.of(0x1b, 0x5b, 0x41)); // ESC [ A (exact bytes): matches
    expect(matches).toEqual(["up"]);
  });

  test("an exact-byte chord matches an unknown sequence the decoder returns as raw", () => {
    // ESC [ 4 8 5 ~ is not a known functional key, so the decoder yields a raw token.
    const unknown = Uint8Array.of(0x1b, 0x5b, 0x34, 0x38, 0x35, 0x7e);
    const chord: ChordElement[] = [{ kind: "bytes", bytes: unknown }];
    const { matcher, output, matches } = setup([
      { id: "x", label: "x", keys: [], chord, action: { type: "quit" } },
    ]);
    matcher.feed(unknown);
    expect(matches).toEqual(["x"]);
    expect(output).toHaveLength(0);
    // A different unknown sequence has no binding and is forwarded verbatim.
    const other = Uint8Array.of(0x1b, 0x5b, 0x39, 0x39, 0x7e);
    matcher.feed(other);
    expect(flattened(output)).toEqual(Array.from(other));
  });

  test("a held prefix that times out forwards its press, repeats, then release in order", async () => {
    const { matcher, output, matches } = setup([binding([4, 4], "double")], 10);
    matcher.feedKeys([ctrlD("press", 1), ctrlD("repeat", 2), ctrlD("repeat", 3)]);
    await Bun.sleep(25); // the single Ctrl-D prefix is not a binding: it times out
    expect(matches).toEqual([]);
    expect(flattened(output)).toEqual([1, 2, 3]); // press then both repeats, transparently
    matcher.feedKeys([ctrlD("release", 4)]);
    expect(flattened(output)).toEqual([1, 2, 3, 4]); // release of the passed-through key
  });

  test("a repeat during an unrelated pending chord is forwarded in arrival order after it resolves", async () => {
    const { matcher, output } = setup([binding([2, 2], "double-b")], 10);
    matcher.feedKeys([plain("x", "press", 120)]); // unbound x: press forwarded immediately
    expect(flattened(output)).toEqual([120]);
    matcher.feedKeys([ctrlB("press", 2)]); // Ctrl-B: a pending chord prefix (held), arrived first...
    matcher.feedKeys([plain("x", "repeat", 121)]); // ...then this x repeat: it must not jump ahead
    expect(flattened(output)).toEqual([120]); // repeat held in position behind the pending Ctrl-B
    await Bun.sleep(25); // the Ctrl-B prefix times out and passes through
    expect(flattened(output)).toEqual([120, 2, 121]); // Ctrl-B press, then the x repeat, in order
  });

  test("release debt does not survive a flag-2 transition to swallow a later passthrough", () => {
    const output: Uint8Array[] = [];
    const matches: string[] = [];
    const matcher = new ShortcutMatcher(
      [binding([4, 4], "double")],
      10,
      (bytes) => output.push(bytes),
      (match) => matches.push(match.label),
    );
    // Event reporting OFF (legacy): completing the chord consumes two presses but no
    // release debt is recorded, since releases never arrive.
    matcher.feedKeys([ctrlD("press", 1), ctrlD("press", 2)]);
    expect(matches).toEqual(["double"]);
    // The child now enables event reporting.
    matcher.setFlags(EVENT_FLAGS);
    // A single Ctrl-D that mismatches (with x) is passed through, press and release.
    matcher.feedKeys([ctrlD("press", 3), plain("x", "press", 120)]);
    expect(flattened(output)).toEqual([3, 120]);
    matcher.feedKeys([ctrlD("release", 4)]);
    expect(flattened(output)).toEqual([3, 120, 4]); // forwarded, not swallowed against stale debt
  });

  test("a text key (Enter) owes no release under flag 2 without flag 8", () => {
    const output: Uint8Array[] = [];
    const matches: string[] = [];
    const matcher = new ShortcutMatcher(
      [binding([13, 13], "double-enter")],
      10,
      (bytes) => output.push(bytes),
      (match) => matches.push(match.label),
    );
    // flag 2 only: Enter is a text key, so the terminal reports no Enter releases.
    matcher.setFlags(KITTY_REPORT_EVENT_TYPES);
    matcher.feedKeys([plain("enter", "press", 1), plain("enter", "press", 2)]);
    expect(matches).toEqual(["double-enter"]); // consumed, but no release debt recorded
    // The child now also enables report-all-keys (so Enter WILL report releases).
    matcher.setFlags(KITTY_REPORT_EVENT_TYPES | KITTY_REPORT_ALL_KEYS);
    // A single Enter that mismatches is passed through; its release must be forwarded.
    matcher.feedKeys([plain("enter", "press", 3), plain("x", "press", 120)]);
    expect(flattened(output)).toEqual([3, 120]);
    matcher.feedKeys([plain("enter", "release", 4)]);
    expect(flattened(output)).toEqual([3, 120, 4]); // not swallowed against stale debt
  });

  test("a release queued before event reporting is disabled is still swallowed on consumption", async () => {
    const { matcher, output, matches } = setup(
      [binding([4], "single"), binding([4, 4], "double")],
      20,
    );
    // Both events arrive under event reporting and are queued while the matcher distinguishes
    // the single and double bindings.
    matcher.feedKeys([ctrlD("press", 1), ctrlD("release", 2)]);
    // The child disables event reporting before the prefix resolves. The already-queued release
    // was generated under the old mode and still exists; a later flag change cannot un-generate it.
    matcher.setFlags(0);
    await Bun.sleep(40); // the single binding wins on timeout and consumes the press
    expect(matches).toEqual(["single"]);
    expect(output).toHaveLength(0); // the queued release is swallowed, not leaked as an orphan
  });

  test("a future release the disabled mode never sends creates no stale debt", async () => {
    const { matcher, output, matches } = setup(
      [binding([4], "single"), binding([4, 4], "double")],
      20,
    );
    matcher.feedKeys([ctrlD("press", 1)]); // only the press; D is still held
    matcher.setFlags(0); // event reporting disabled before D is released: no release will arrive
    await Bun.sleep(40); // the single binding consumes the press; there is no release to owe
    expect(matches).toEqual(["single"]);
    // Reporting is re-enabled; an unrelated plain-D (same physical key) press/release must pass
    // through balanced, not be swallowed against a stale ctrl-d debt.
    matcher.setFlags(EVENT_FLAGS);
    matcher.feedKeys([plain("d", "press", 100), plain("d", "release", 101)]);
    expect(flattened(output)).toEqual([100, 101]);
  });

  test("an app-cursor binding matches SS3 always, and the base cursor only when enhanced", () => {
    const output: Uint8Array[] = [];
    const matches: string[] = [];
    const matcher = new ShortcutMatcher(
      [
        {
          id: "a",
          label: "app-up",
          keys: [],
          chord: compileChord(["app-up"]),
          action: { type: "quit" },
        },
      ],
      50,
      (bytes) => output.push(bytes),
      (match) => matches.push(match.label),
    );
    // Legacy (no flags): SS3 ESC O A matches; normal cursor ESC [ A does not.
    matcher.feed(Uint8Array.of(0x1b, 0x4f, 0x41)); // ESC O A
    expect(matches).toEqual(["app-up"]);
    matcher.feed(Uint8Array.of(0x1b, 0x5b, 0x41)); // ESC [ A (normal Up): no match, forwarded
    expect(matches).toEqual(["app-up"]);
    expect(flattened(output)).toEqual([0x1b, 0x5b, 0x41]);
    // Enhanced: the cursor arrives canonical (ESC [ A -> up), which now matches.
    matcher.setFlags(KITTY_REPORT_ALL_KEYS);
    matcher.feed(Uint8Array.of(0x1b, 0x5b, 0x41));
    expect(matches).toEqual(["app-up", "app-up"]);
  });

  test("a passive flag (4) alone does not make app-up consume normal cursor input", () => {
    const output: Uint8Array[] = [];
    const matches: string[] = [];
    const matcher = new ShortcutMatcher(
      [chordBinding("app-up", "app-up")],
      50,
      (bytes) => output.push(bytes),
      (match) => matches.push(match.label),
    );
    // Flag 4 (alternate keys) is passive: it does not canonicalize cursor input, so
    // legacy application-cursor mode is still distinct — normal Up must not match.
    matcher.setFlags(KITTY_REPORT_ALTERNATE_KEYS);
    matcher.feed(Uint8Array.of(0x1b, 0x5b, 0x41)); // ESC [ A (normal Up)
    expect(matches).toEqual([]);
    expect(flattened(output)).toEqual([0x1b, 0x5b, 0x41]);
  });

  test("release debt survives an unrelated flag change that still reports the key", () => {
    const output: Uint8Array[] = [];
    const matches: string[] = [];
    const matcher = new ShortcutMatcher(
      [binding([4], "single")],
      1000,
      (bytes) => output.push(bytes),
      (match) => matches.push(match.label),
    );
    matcher.setFlags(EVENT_FLAGS); // 2 + 8
    matcher.feedKeys([ctrlD("press", 1)]); // consumed -> owes a Ctrl-D release
    expect(matches).toEqual(["single"]);
    // Toggle alternate-keys (flag 4) while event reporting stays on: Ctrl-D still
    // reports releases, so the outstanding debt must NOT be discarded.
    matcher.setFlags(EVENT_FLAGS | KITTY_REPORT_ALTERNATE_KEYS);
    matcher.feedKeys([ctrlD("release", 2)]);
    expect(output).toHaveLength(0); // release still swallowed against the kept debt
  });

  test("a base-layout alternate lets a shortcut fire regardless of keyboard layout", () => {
    const output: Uint8Array[] = [];
    const matches: string[] = [];
    const matcher = new ShortcutMatcher(
      [binding([3], "ctrl-c")],
      50,
      (bytes) => output.push(bytes),
      (match) => matches.push(match.label),
    );
    matcher.setFlags(KITTY_REPORT_ALTERNATE_KEYS);
    // A Cyrillic key (primary 1234) with an empty shifted field and base-layout 'c'
    // (99), Ctrl held. The ctrl-c binding fires via the base-layout alternate.
    matcher.feed(bytes("\x1b[1234::99;5u"));
    expect(matches).toEqual(["ctrl-c"]);
  });

  test("a shifted alternate lets a shortcut fire on its shifted character", () => {
    const output: Uint8Array[] = [];
    const matches: string[] = [];
    const matcher = new ShortcutMatcher(
      [chordBinding("@", "at")],
      50,
      (bytes) => output.push(bytes),
      (match) => matches.push(match.label),
    );
    matcher.setFlags(KITTY_REPORT_ALTERNATE_KEYS);
    // '2' (50) shifted to '@' (64), Shift held: the "@" binding fires.
    matcher.feed(bytes("\x1b[50:64;2u"));
    expect(matches).toEqual(["at"]);
  });
});
