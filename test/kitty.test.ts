import { describe, expect, test } from "bun:test";
import {
  bytesKey,
  chordCanon,
  chordsOverlap,
  compileChord,
  decodeLegacyKey,
  encodeCsiU,
  encodeKeyActive,
  encodeKeysActive,
  keyId,
  parseKeyName,
} from "../src/keys";
import { KeyboardModeStack, KITTY_DISAMBIGUATE, KITTY_REPORT_ALL_KEYS } from "../src/kitty";

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const idOf = (s: string) => keyId(parseKeyName(s));

// Decode the single key at the start of `s` and return its keyId, or a tag for raw/incomplete.
function decodeId(s: string): string {
  const r = decodeLegacyKey(bytes(s));
  if (r === null) return "<incomplete>";
  if (r.token.kind === "raw") return "<raw>";
  return keyId(r.token.key);
}

describe("parseKeyName / keyId", () => {
  test("normalizes the binding vocabulary to stable ids", () => {
    expect(idOf("ctrl-d")).toBe("ctrl+d");
    expect(idOf("ctrl-b")).toBe("ctrl+b");
    expect(idOf("up")).toBe("up");
    expect(idOf("shift-up")).toBe("shift+up");
    expect(idOf("ctrl-alt-f5")).toBe("ctrl+alt+f5");
    expect(idOf("alt-f")).toBe("alt+f");
    expect(idOf("a")).toBe("a");
    expect(idOf("A")).toBe("shift+a"); // uppercase == shift+lowercase
    expect(idOf("enter")).toBe("enter");
    expect(idOf("escape")).toBe("escape");
    expect(idOf("space")).toBe("space");
    expect(idOf("ctrl-space")).toBe("ctrl+space");
    expect(idOf("hex:04")).toBe("ctrl+d"); // raw byte resolves to the same key
  });
});

describe("decodeLegacyKey", () => {
  test("legacy control bytes and escape sequences", () => {
    expect(decodeId("\x04")).toBe("ctrl+d");
    expect(decodeId("\x02")).toBe("ctrl+b");
    expect(decodeId("\r")).toBe("enter");
    expect(decodeId("\x7f")).toBe("backspace");
    expect(decodeId("a")).toBe("a");
    expect(decodeId("A")).toBe("shift+a");
    expect(decodeId("\x1b[A")).toBe("up");
    expect(decodeId("\x1bOP")).toBe("f1");
    expect(decodeId("\x1bf")).toBe("alt+f");
  });

  test("Kitty CSI-u key reports decode to the same ids as the legacy forms", () => {
    expect(decodeId("\x1b[100;5u")).toBe("ctrl+d"); // the whole point
    expect(decodeId("\x1b[98;5u")).toBe("ctrl+b");
    expect(decodeId("\x1b[97u")).toBe("a");
    expect(decodeId("\x1b[97;2u")).toBe("shift+a");
    expect(decodeId("\x1b[13u")).toBe("enter");
    expect(decodeId("\x1b[27u")).toBe("escape");
    expect(decodeId("\x1b[1;5A")).toBe("ctrl+up");
    expect(decodeId("\x1b[15;5~")).toBe("ctrl+f5");
  });

  test("non-key sequences pass through as raw, and release events are marked", () => {
    expect(decodeId("\x1b[<0;10;5M")).toBe("<raw>"); // mouse
    expect(decodeId("\x1b[?1u")).toBe("<raw>"); // Kitty query reply, not a key
    const release = decodeLegacyKey(bytes("\x1b[100;5:3u"));
    expect(release?.token.kind === "key" && release.token.event).toBe("release");
  });

  test("incomplete sequences ask for more bytes", () => {
    expect(decodeId("\x1b")).toBe("<incomplete>");
    expect(decodeId("\x1b[")).toBe("<incomplete>");
    expect(decodeId("\x1b[100;5")).toBe("<incomplete>");
  });

  test("malformed or unsupported CSI-u sequences forward as raw instead of crashing", () => {
    expect(decodeId("\x1b[999999999u")).toBe("<raw>"); // far past the Unicode range
    expect(decodeId("\x1b[1114112u")).toBe("<raw>"); // 0x110000, one past the max scalar
    expect(decodeId("\x1b[55296u")).toBe("<raw>"); // 0xD800, a lone surrogate
    expect(decodeId("\x1b[-1;5u")).toBe("<raw>"); // non-digit codepoint field
    expect(decodeId("\x1b[97;0u")).toBe("<raw>"); // modifier value below 1
    expect(decodeId("\x1b[97;9u")).toBe("<raw>"); // super modifier: cannot be represented
    expect(decodeId("\x1b[97;1:9u")).toBe("<raw>"); // unknown event type
  });

  test("malformed ignored subfields and extra parameters keep the sequence raw", () => {
    // Valid alternate-key (with Shift held) and associated-text codepoints still decode.
    expect(decodeId("\x1b[97:66;2u")).toBe("shift+a"); // 'a' with shifted alternate 'B', Shift held
    expect(decodeId("\x1b[97;1;98u")).toBe("a"); // 'a' with associated text 'b'
    // Malformed / protocol-invalid ignored fields must NOT smuggle in a key.
    expect(decodeId("\x1b[97:xu")).toBe("<raw>"); // non-numeric alternate key
    expect(decodeId("\x1b[97:66u")).toBe("<raw>"); // shifted alternate without Shift held
    expect(decodeId("\x1b[97;1;zu")).toBe("<raw>"); // non-numeric associated text
    expect(decodeId("\x1b[97;1;9u")).toBe("<raw>"); // associated text is a C0 control (0x09)
    expect(decodeId("\x1b[97;1;155u")).toBe("<raw>"); // associated text is a C1 control (0x9b)
    expect(decodeId("\x1b[97;1;98;1u")).toBe("<raw>"); // too many fields
    expect(decodeId("\x1b[97:65:99:100u")).toBe("<raw>"); // too many alternate-key subfields
    expect(decodeId("\x1b[97;5:u")).toBe("<raw>"); // empty event subfield after a colon
    expect(decodeId("\x1b[1:x;5A")).toBe("<raw>"); // malformed functional-key subfield
    expect(decodeId("\x1b[1;5;9A")).toBe("<raw>"); // too many functional fields
  });

  test("functional-key CSI must match its exact numeric grammar", () => {
    // Valid functional forms still decode.
    expect(decodeId("\x1b[A")).toBe("up"); // bare CSI A (implied 1)
    expect(decodeId("\x1b[1;5A")).toBe("ctrl+up"); // CSI 1 ; 5 A
    expect(decodeId("\x1b[15;5~")).toBe("ctrl+f5");
    // Wrong number for a letter-final must not be normalized to the implied-1 key.
    expect(decodeId("\x1b[999;5A")).toBe("<raw>"); // 999 A is not Ctrl-Up
    expect(decodeId("\x1b[2A")).toBe("<raw>");
    // A lone numeric parameter on a letter-final key is not a valid form.
    expect(decodeId("\x1b[1A")).toBe("<raw>"); // must be bare CSI A or CSI 1;mods A
    expect(decodeId("\x1b[1P")).toBe("<raw>");
    expect(decodeId("\x1b[1S")).toBe("<raw>");
    // ...but the modified form with an explicit no-op modifier is valid.
    expect(decodeId("\x1b[1;1A")).toBe("up");
    // Colon subfields do not belong on a functional numeric parameter.
    expect(decodeId("\x1b[1:2;5A")).toBe("<raw>");
    expect(decodeId("\x1b[15:2;5~")).toBe("<raw>");
    // A tilde-final with an undefined number stays raw.
    expect(decodeId("\x1b[16~")).toBe("<raw>");
  });

  test("ambient lock modifiers are ignored, not treated as key modifiers", () => {
    // caps-lock (64) / num-lock (128) are state, not intent: a with caps-lock is `a`.
    expect(decodeId("\x1b[97;65u")).toBe("a"); // 65 = 1 + caps-lock(64)
    expect(decodeId("\x1b[97;130u")).toBe("shift+a"); // 130 = 1 + shift(1) + num-lock(128)
  });

  test("raw preserves the exact input bytes for faithful forwarding", () => {
    const r = decodeLegacyKey(bytes("\x1b[100;5u"));
    expect(r?.token.kind).toBe("key");
    if (r?.token.kind === "key") expect(bytesKey(r.token.raw)).toBe(bytesKey(bytes("\x1b[100;5u")));
  });
});

describe("encode (mode-aware)", () => {
  test("encodeCsiU mirrors the decoder", () => {
    expect(bytesKey(encodeCsiU(parseKeyName("ctrl-d")))).toBe(bytesKey(bytes("\x1b[100;5u")));
    expect(bytesKey(encodeCsiU(parseKeyName("a")))).toBe(bytesKey(bytes("\x1b[97u")));
  });

  test("encodeKeyActive: legacy unless report-all-keys is negotiated", () => {
    const d = parseKeyName("ctrl-d");
    expect(bytesKey(encodeKeyActive(d, 0))).toBe("04");
    // Under disambiguate, ctrl+letter combinations are reported as CSI-u.
    expect(bytesKey(encodeKeyActive(d, KITTY_DISAMBIGUATE))).toBe(bytesKey(bytes("\x1b[100;5u")));
    expect(bytesKey(encodeKeyActive(d, KITTY_REPORT_ALL_KEYS))).toBe(
      bytesKey(bytes("\x1b[100;5u")),
    );
    expect(bytesKey(encodeKeysActive(["ctrl-d"], KITTY_REPORT_ALL_KEYS))).toBe(
      bytesKey(bytes("\x1b[100;5u")),
    );
  });

  test("round-trip: decode(encodeCsiU(k)) has the same id", () => {
    for (const spec of [
      "ctrl-d",
      "ctrl-b",
      "a",
      "shift-a",
      "alt-f",
      "enter",
      "ctrl-up",
      "f3",
      "f5",
    ]) {
      const k = parseKeyName(spec);
      const r = decodeLegacyKey(encodeCsiU(k));
      expect(r?.token.kind === "key" && keyId(r.token.key)).toBe(keyId(k));
    }
  });

  test("F3 uses CSI 13 ~ (not the CSI R that collides with cursor-position reports)", () => {
    expect(bytesKey(encodeCsiU(parseKeyName("f3")))).toBe(bytesKey(bytes("\x1b[13~")));
    expect(
      bytesKey(encodeCsiU({ name: "f3", mods: { ctrl: true, alt: false, shift: false } })),
    ).toBe(bytesKey(bytes("\x1b[13;5~")));
    expect(decodeId("\x1b[13~")).toBe("f3");
    expect(decodeId("\x1b[13;5~")).toBe("ctrl+f3");
    expect(decodeId("\x1b[R")).toBe("<raw>"); // bare CSI R stays a cursor-position report
  });

  test("under disambiguate flag 1, functional and app-cursor sends use CSI form", () => {
    const one = KITTY_DISAMBIGUATE;
    // Unmodified functional keys are enhanced under flag 1 (CSI, not SS3).
    expect(bytesKey(encodeKeysActive(["f1"], one))).toBe(bytesKey(bytes("\x1b[P")));
    expect(bytesKey(encodeKeysActive(["f4"], one))).toBe(bytesKey(bytes("\x1b[S")));
    expect(bytesKey(encodeKeysActive(["up"], one))).toBe(bytesKey(bytes("\x1b[A")));
    expect(bytesKey(encodeKeysActive(["home"], one))).toBe(bytesKey(bytes("\x1b[H")));
    expect(bytesKey(encodeKeysActive(["end"], one))).toBe(bytesKey(bytes("\x1b[F")));
    // app-up sends the canonical base cursor (CSI A), not SS3 ESC O A.
    expect(bytesKey(encodeKeysActive(["app-up"], one))).toBe(bytesKey(bytes("\x1b[A")));
    // Text keys still stay legacy under flag 1.
    expect(bytesKey(encodeKeysActive(["a"], one))).toBe("61");
    expect(bytesKey(encodeKeysActive(["enter"], one))).toBe("0d");
  });
});

describe("chord identity (binding vocabulary)", () => {
  test("a multi-byte hex entry expands to one exact-byte element per keystroke", () => {
    // hex:026e == Ctrl-B (0x02) then n (0x6e): two keystrokes, not a one-key Ctrl-B.
    const chord = compileChord(["hex:026e"]);
    expect(chord).toHaveLength(2);
    expect(chordCanon(chord)).toBe("b:02 b:6e");
  });

  test("an exact CSI hex entry stays exact bytes, not a semantic key", () => {
    const chord = compileChord(["hex:1b5b41"]); // ESC [ A
    expect(chord).toEqual([{ kind: "bytes", bytes: Uint8Array.of(0x1b, 0x5b, 0x41) }]);
  });

  test("control aliases keep the literal key as primary, the legacy byte as fallback", () => {
    // Primary identity is the configured/disambiguated key (what Kitty reports);
    // the ambiguous legacy control byte is only an additional accept identity.
    expect(chordCanon(compileChord(["ctrl-i"]))).toBe("ctrl+i|tab");
    expect(chordCanon(compileChord(["ctrl-m"]))).toBe("ctrl+m|enter");
    expect(chordCanon(compileChord(["ctrl-["]))).toBe("ctrl+[|escape");
    expect(chordCanon(compileChord(["ctrl-8"]))).toBe("backspace|ctrl+8");
    expect(chordCanon(compileChord(["ctrl-2"]))).toBe("ctrl+2|ctrl+space");
    expect(chordCanon(compileChord(["ctrl-?"]))).toBe("backspace|ctrl+?");
    expect(chordCanon(compileChord(["ctrl-@"]))).toBe("ctrl+@|ctrl+space");
  });

  test("control aliases send the disambiguated key under Kitty, the legacy byte otherwise", () => {
    // Under flag 1, ctrl-8 sends CSI 56;5u (ctrl+8), not the legacy 0x7f / CSI 127;5u.
    expect(bytesKey(encodeKeysActive(["ctrl-8"], KITTY_DISAMBIGUATE))).toBe(
      bytesKey(bytes("\x1b[56;5u")),
    );
    expect(bytesKey(encodeKeysActive(["ctrl-2"], KITTY_DISAMBIGUATE))).toBe(
      bytesKey(bytes("\x1b[50;5u")),
    );
    expect(bytesKey(encodeKeysActive(["ctrl-8"], 0))).toBe("7f"); // legacy byte unchanged
  });

  test("application-cursor keys: distinct legacy identity, base cursor only when enhanced", () => {
    // app-up carries its distinct SS3 identity plus the base cursor as an enhanced-only
    // accept id; up is just up. They still overlap (ambiguous under enhancement).
    expect(chordCanon(compileChord(["app-up"]))).toBe("app-up^up");
    expect(chordCanon(compileChord(["up"]))).toBe("up");
    expect(chordsOverlap(compileChord(["app-up"]), compileChord(["up"]))).toBe(true);
    expect(decodeId("\x1bOA")).toBe("app-up"); // SS3 application cursor
    expect(decodeId("\x1b[A")).toBe("up"); // CSI normal cursor
    // Under Kitty, a send collapses app-up to the base cursor (no app distinction).
    expect(bytesKey(encodeKeysActive(["app-up"], KITTY_REPORT_ALL_KEYS))).toBe(
      bytesKey(bytes("\x1b[A")),
    );
    // Legacy send preserves the application-cursor bytes.
    expect(bytesKey(encodeKeysActive(["app-up"], 0))).toBe(bytesKey(bytes("\x1bOA")));
  });

  test("overlap detection catches byte-equivalent hex vs named chords", () => {
    expect(chordsOverlap(compileChord(["hex:026e"]), compileChord(["ctrl-b", "n"]))).toBe(true);
    expect(chordsOverlap(compileChord(["ctrl-b", "e"]), compileChord(["ctrl-b", "n"]))).toBe(false);
  });

  test("send re-encoding preserves app-cursor and exact-byte specs, adapts otherwise", () => {
    // Legacy mode keeps each spec's own bytes (app-up is NOT flattened to normal up).
    expect(bytesKey(encodeKeysActive(["app-up"], 0))).toBe(bytesKey(bytes("\x1bOA")));
    expect(bytesKey(encodeKeysActive(["up"], 0))).toBe(bytesKey(bytes("\x1b[A")));
    // Exact hex is always verbatim, in any mode.
    expect(bytesKey(encodeKeysActive(["hex:026e"], KITTY_REPORT_ALL_KEYS))).toBe("026e");
    // ctrl+letter re-encodes to CSI-u under disambiguate.
    expect(bytesKey(encodeKeysActive(["ctrl-d"], KITTY_DISAMBIGUATE))).toBe(
      bytesKey(bytes("\x1b[100;5u")),
    );
  });
});

describe("KeyboardModeStack", () => {
  test("push / pop / set-or-and from child output", () => {
    const s = new KeyboardModeStack();
    expect(s.current()).toBe(0);
    s.feed(bytes("\x1b[>8u"));
    expect(s.current()).toBe(8);
    s.feed(bytes("hello world (no sequences)"));
    expect(s.current()).toBe(8);
    s.feed(bytes("\x1b[<u")); // pop (default 1)
    expect(s.current()).toBe(0);

    s.feed(bytes("\x1b[=8;1u")); // set 8 on empty
    expect(s.current()).toBe(8);
    s.feed(bytes("\x1b[=1;2u")); // or 1 -> 9
    expect(s.current()).toBe(9);
    s.feed(bytes("\x1b[=8;3u")); // and-not 8 -> 1
    expect(s.current()).toBe(1);
  });

  test("ignores the query reply and unrelated CSI", () => {
    const s = new KeyboardModeStack();
    s.feed(bytes("\x1b[>8u"));
    s.feed(bytes("\x1b[?8u")); // query reply
    s.feed(bytes("\x1b[?25h")); // show cursor
    expect(s.current()).toBe(8);
  });

  test("is safe across arbitrary chunk splits", () => {
    const full = bytes("prefix\x1b[>8usuffix\x1b[<u");
    for (let cut = 1; cut < full.length; cut += 1) {
      const s = new KeyboardModeStack();
      s.feed(full.subarray(0, cut));
      s.feed(full.subarray(cut));
      expect(s.current()).toBe(0); // pushed 8 then popped -> back to 0
    }
    // and a split that lands mid-push leaves 8 active
    const push = bytes("\x1b[>8u");
    for (let cut = 1; cut < push.length; cut += 1) {
      const s = new KeyboardModeStack();
      s.feed(push.subarray(0, cut));
      s.feed(push.subarray(cut));
      expect(s.current()).toBe(8);
    }
  });

  test("keeps independent keyboard-mode stacks for the main and alternate screens", () => {
    const s = new KeyboardModeStack();
    s.feed(bytes("\x1b[>1u")); // main screen: push flag 1
    expect(s.current()).toBe(1);
    s.feed(bytes("\x1b[?1049h")); // enter the alternate screen (empty stack)
    expect(s.current()).toBe(0);
    s.feed(bytes("\x1b[>8u")); // alt screen: push flag 8
    expect(s.current()).toBe(8);
    s.feed(bytes("\x1b[?1049l")); // leave the alternate screen -> back to main
    expect(s.current()).toBe(1); // main still flag 1, NOT the alt screen's 8
  });

  test("also switches screens via the 47 and 1047 alternate-screen modes", () => {
    for (const mode of ["47", "1047", "1049"]) {
      const s = new KeyboardModeStack();
      s.feed(bytes("\x1b[>1u"));
      s.feed(bytes(`\x1b[?${mode}h\x1b[>8u`));
      expect(s.current()).toBe(8);
      s.feed(bytes(`\x1b[?${mode}l`));
      expect(s.current()).toBe(1);
    }
  });

  test("tracks screen switches and mutations across every chunk split", () => {
    const full = bytes("\x1b[>1u\x1b[?1049h\x1b[>8u\x1b[?1049l");
    for (let cut = 1; cut < full.length; cut += 1) {
      const s = new KeyboardModeStack();
      s.feed(full.subarray(0, cut));
      s.feed(full.subarray(cut));
      expect(s.current()).toBe(1); // ends on the main screen with flag 1
    }
  });

  test("record-and-replay captures the child's mode controls made behind a modal", () => {
    const s = new KeyboardModeStack();
    s.feed(bytes("\x1b[>8u")); // main [8]
    s.startRecording();
    // Visible output is ignored; only the mode-control sequences are captured.
    s.feed(bytes("visible\x1b[<u\x1b[>1u more"));
    expect(new TextDecoder().decode(s.stopRecording())).toBe("\x1b[<u\x1b[>1u");
    expect(s.current()).toBe(1);
  });

  test("record-and-replay preserves hidden alt-to-alt mechanism replacement", () => {
    const s = new KeyboardModeStack();
    s.feed(bytes("\x1b[?47h")); // on alt via 47
    s.startRecording();
    // Leave 47 and re-enter alt via 1049 behind the modal: both transitions are kept,
    // even though the final buffer name (alt) is unchanged.
    s.feed(bytes("\x1b[?47l\x1b[?1049h"));
    expect(new TextDecoder().decode(s.stopRecording())).toBe("\x1b[?47l\x1b[?1049h");
  });

  test("record-and-replay preserves a multi-parameter alternate-screen DECSET verbatim", () => {
    const s = new KeyboardModeStack();
    s.startRecording();
    s.feed(bytes("\x1b[?47;1049h"));
    expect(new TextDecoder().decode(s.stopRecording())).toBe("\x1b[?47;1049h");
  });

  test("any alternate-screen reset returns to the main buffer, not a reference count", () => {
    // After a multi-parameter set, resetting ANY one alt mode switches to the main
    // buffer (a DEC action), so the next Kitty mutation must affect the main stack.
    for (const reset of ["47", "1047", "1049"]) {
      const s = new KeyboardModeStack();
      s.feed(bytes("\x1b[>1u\x1b[?47;1049h")); // main[1]; enter alt via 47 AND 1049
      expect(s.current()).toBe(0); // on alt, empty alt stack
      s.feed(bytes(`\x1b[?${reset}l`)); // any reset returns to main
      s.feed(bytes("\x1b[>8u")); // this push affects the MAIN stack
      expect(s.current()).toBe(8); // main is now [1, 8]
    }
  });

  test("resetSequence clears both keyboard stacks and restores the main screen", () => {
    // On the alt screen (entered via 1047) with alt [8] over main [1].
    const s = new KeyboardModeStack();
    s.feed(bytes("\x1b[>1u\x1b[?1047h\x1b[>8u"));
    const state = s.snapshot();
    expect(state.active).toBe("alt");
    expect(state.altSetModes).toEqual([1047]);
    // Pop the alt stack, leave alt with 1047, then pop the main stack.
    expect(bytesKey(s.resetSequence(state))).toBe(bytesKey(bytes("\x1b[<u\x1b[?1047l\x1b[<u")));
  });

  test("resetSequence visits a nonempty inactive alternate stack to clear it", () => {
    // Back on main, but the alt screen still has an enhanced stack the child left.
    const s = new KeyboardModeStack();
    s.feed(bytes("\x1b[>1u\x1b[?1049h\x1b[>8u\x1b[?1049l"));
    const state = s.snapshot();
    expect(state.active).toBe("main");
    // Enter alt with the NON-saving 47 (not 1049, which would clobber a saved cursor),
    // pop the alt stack, leave with 47, pop the main stack.
    expect(bytesKey(s.resetSequence(state))).toBe(
      bytesKey(bytes("\x1b[?47h\x1b[<u\x1b[?47l\x1b[<u")),
    );
  });

  test("cleanup visits an inactive alt stack without clobbering a still-saved 1049 cursor", () => {
    // ?1049;47h saves the cursor and enters alt; a push; then ?47l returns to main while
    // 1049 stays set. Cleanup must NOT re-enter with 1049 (which would overwrite the
    // child's saved cursor) — it uses 47, then resets 47 (temp) and 1049 (child restore).
    const s = new KeyboardModeStack();
    s.feed(bytes("\x1b[>1u\x1b[?1049;47h\x1b[>8u\x1b[?47l"));
    const state = s.snapshot();
    expect(state.active).toBe("main");
    expect(state.alt).toEqual([8]);
    expect(state.altSetModes).toEqual([1049]);
    expect(bytesKey(s.resetSequence(state))).toBe(
      bytesKey(bytes("\x1b[?47h\x1b[<u\x1b[?47l\x1b[?1049l\x1b[<u")),
    );
  });

  test("a control split across the modal-close boundary is emitted whole by feed, never partial", () => {
    // Hidden prefix, visible suffix: the child emits ESC [ > while suppressed, the modal
    // closes, then 8 u arrives exposed. The incomplete prefix is NOT flushed on close —
    // if it were, a wrapper write (status row / failure notice) between the flush and the
    // suffix would cancel it, leaving the terminal with only an orphaned suffix. Instead
    // feed() holds the prefix and emits the whole control once the suffix completes it.
    const s = new KeyboardModeStack();
    s.startRecording();
    expect(s.feed(bytes("\x1b[>")).length).toBe(0); // incomplete control, suppressed and held
    // Close flushes nothing: the partial prefix stays held in the carry.
    expect(s.stopRecording().length).toBe(0);
    // The exposed suffix completes the control; feed emits the WHOLE sequence, in order.
    expect(new TextDecoder().decode(s.feed(bytes("8u")))).toBe("\x1b[>8u");
    expect(s.current()).toBe(8);
  });

  test("record/replay re-sends the full control when an exposed prefix was cancelled", () => {
    // Exposed prefix, suppressed suffix. The modal's own render cancels the partial
    // ESC [ > already on the terminal (modeled at the PTY level), so the whole control
    // — not just the suffix — must be captured and replayed to re-establish it.
    const s = new KeyboardModeStack();
    s.feed(bytes("\x1b[>")); // exposed before recording (carried)
    s.startRecording();
    s.feed(bytes("8u")); // suppressed suffix completes the control
    expect(s.current()).toBe(8);
    expect(new TextDecoder().decode(s.stopRecording())).toBe("\x1b[>8u");
  });

  test("cleanup resets every mode of a combined alternate-screen DECSET, in reverse order", () => {
    const s = new KeyboardModeStack();
    s.feed(bytes("\x1b[>1u\x1b[?47;1049h\x1b[>8u")); // main[1]; enter alt via 47 AND 1049; alt[8]
    const state = s.snapshot();
    expect(state.active).toBe("alt");
    expect(state.altSetModes).toEqual([47, 1049]);
    // Pop alt, reset 1049 then 47 (reverse, so 1049's restore runs), pop main.
    expect(bytesKey(s.resetSequence(state))).toBe(
      bytesKey(bytes("\x1b[<u\x1b[?1049l\x1b[?47l\x1b[<u")),
    );
  });

  test("cleanup honors the DECSET order for a reversed combined set", () => {
    const s = new KeyboardModeStack();
    s.feed(bytes("\x1b[>1u\x1b[?1049;47h\x1b[>8u"));
    const state = s.snapshot();
    expect(state.altSetModes).toEqual([1049, 47]);
    expect(bytesKey(s.resetSequence(state))).toBe(
      bytesKey(bytes("\x1b[<u\x1b[?47l\x1b[?1049l\x1b[<u")),
    );
  });

  test("a long recording is replayed VERBATIM in order, preserving an outstanding 1049 and its reset", () => {
    // A hidden 1049 enter (which saves the cursor) followed later by its 1049l reset: both
    // must appear in the replay, in order — a final-state summary could not reproduce this.
    // The log is not capped, so even a large volume of controls replays completely.
    const s = new KeyboardModeStack();
    s.startRecording();
    s.feed(bytes("\x1b[?1049h\x1b[>8u")); // enter alt via 1049 (saves cursor), push
    let expected = "\x1b[?1049h\x1b[>8u";
    for (let k = 0; k < 5000; k += 1) {
      s.feed(bytes("\x1b[>2u\x1b[<u"));
      expected += "\x1b[>2u\x1b[<u";
    }
    s.feed(bytes("\x1b[<u\x1b[?1049l")); // pop, then leave alt (restores the saved cursor)
    expected += "\x1b[<u\x1b[?1049l";
    const snap = s.snapshot();
    expect(snap.active).toBe("main");
    expect(snap.altSetModes).toEqual([]);
    expect(new TextDecoder().decode(s.stopRecording())).toBe(expected);
  });

  test("an inactive nonempty alt stack replays verbatim and still holds a trailing partial", () => {
    // Active-main with a nonempty inactive alt stack and an outstanding mode, recorded over
    // a large volume: verbatim replay reproduces the complete ordered log exactly.
    const s = new KeyboardModeStack();
    s.startRecording();
    s.feed(bytes("\x1b[>1u\x1b[?1049;47h\x1b[>8u\x1b[?47l")); // main[1]; alt[8]; back to main, 1049 lingers
    let expected = "\x1b[>1u\x1b[?1049;47h\x1b[>8u\x1b[?47l";
    for (let k = 0; k < 5000; k += 1) {
      s.feed(bytes("\x1b[>0u\x1b[<u"));
      expected += "\x1b[>0u\x1b[<u";
    }
    // ...ending in a trailing INCOMPLETE control, which stays held (not in the replay).
    expect(s.feed(bytes("\x1b[>")).length).toBe(0);
    const snap = s.snapshot();
    expect(snap.active).toBe("main");
    expect(snap.main).toEqual([1]);
    expect(snap.alt).toEqual([8]);
    expect(snap.altSetModes).toEqual([1049]);
    expect(new TextDecoder().decode(s.stopRecording())).toBe(expected);
    // The held partial survived; a later suffix completes it and feed emits it whole.
    expect(new TextDecoder().decode(s.feed(bytes("2u")))).toBe("\x1b[>2u");
  });

  test("discardRecording drops the recorded log without replaying", () => {
    const s = new KeyboardModeStack();
    s.startRecording();
    for (let k = 0; k < 50; k += 1) s.feed(bytes("\x1b[>8u\x1b[<u"));
    s.discardRecording();
    // A fresh recording after a discard replays only its own controls.
    s.startRecording();
    s.feed(bytes("\x1b[>3u"));
    expect(new TextDecoder().decode(s.stopRecording())).toBe("\x1b[>3u");
  });

  test("the recorded log is BOUNDED: sustained controls past the limit overflow and stop retaining", () => {
    // A small limit makes the bound observable. Feed far more controls than the limit for
    // longer than any modal would realistically stay open.
    const s = new KeyboardModeStack({ recordingLimit: 100 });
    s.startRecording();
    expect(s.recordingOverflowed()).toBe(false);
    for (let k = 0; k < 100000; k += 1) s.feed(bytes("\x1b[>0u")); // 5 bytes each -> ~500 KB fed
    // Overflow is flagged (the session would make its safe transition here)...
    expect(s.recordingOverflowed()).toBe(true);
    // ...and the RETAINED data stays bounded near the limit, never the whole ~500 KB flood,
    // so close-time allocation/write is bounded too.
    const replay = s.stopRecording();
    expect(replay.length).toBeLessThanOrEqual(105); // <= limit + one straddling control
    // A fresh recording starts clean (overflow reset).
    s.startRecording();
    expect(s.recordingOverflowed()).toBe(false);
    s.feed(bytes("\x1b[>3u"));
    expect(new TextDecoder().decode(s.stopRecording())).toBe("\x1b[>3u");
  });
});
