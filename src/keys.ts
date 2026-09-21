import { KITTY_DISAMBIGUATE, KITTY_REPORT_ALL_KEYS, KITTY_REPORT_EVENT_TYPES } from "./kitty";

const encoder = new TextEncoder();

export const NAMED_KEY_ENCODINGS = {
  enter: "\r",
  return: "\r",
  tab: "\t",
  "shift-tab": "\x1b[Z",
  backtab: "\x1b[Z",
  backspace: "\x7f",
  escape: "\x1b",
  esc: "\x1b",
  space: " ",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  insert: "\x1b[2~",
  ins: "\x1b[2~",
  delete: "\x1b[3~",
  del: "\x1b[3~",
  "page-up": "\x1b[5~",
  pgup: "\x1b[5~",
  "page-down": "\x1b[6~",
  pgdn: "\x1b[6~",
  "app-up": "\x1bOA",
  "app-down": "\x1bOB",
  "app-right": "\x1bOC",
  "app-left": "\x1bOD",
  "app-home": "\x1bOH",
  "app-end": "\x1bOF",
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  f5: "\x1b[15~",
  f6: "\x1b[17~",
  f7: "\x1b[18~",
  f8: "\x1b[19~",
  f9: "\x1b[20~",
  f10: "\x1b[21~",
  f11: "\x1b[23~",
  f12: "\x1b[24~",
} as const satisfies Readonly<Record<string, string>>;

type ModifiedNamedKey = {
  parameter: string;
  final: string;
};

const modifiedNamedKeys: Readonly<Record<string, ModifiedNamedKey>> = {
  up: { parameter: "1", final: "A" },
  down: { parameter: "1", final: "B" },
  right: { parameter: "1", final: "C" },
  left: { parameter: "1", final: "D" },
  home: { parameter: "1", final: "H" },
  end: { parameter: "1", final: "F" },
  insert: { parameter: "2", final: "~" },
  ins: { parameter: "2", final: "~" },
  delete: { parameter: "3", final: "~" },
  del: { parameter: "3", final: "~" },
  "page-up": { parameter: "5", final: "~" },
  pgup: { parameter: "5", final: "~" },
  "page-down": { parameter: "6", final: "~" },
  pgdn: { parameter: "6", final: "~" },
  f1: { parameter: "1", final: "P" },
  f2: { parameter: "1", final: "Q" },
  f3: { parameter: "1", final: "R" },
  f4: { parameter: "1", final: "S" },
  f5: { parameter: "15", final: "~" },
  f6: { parameter: "17", final: "~" },
  f7: { parameter: "18", final: "~" },
  f8: { parameter: "19", final: "~" },
  f9: { parameter: "20", final: "~" },
  f10: { parameter: "21", final: "~" },
  f11: { parameter: "23", final: "~" },
  f12: { parameter: "24", final: "~" },
};

const controlAliases: Readonly<Record<string, number>> = {
  "2": 0,
  "3": 27,
  "4": 28,
  "5": 29,
  "6": 30,
  "7": 31,
  "8": 127,
  "?": 127,
};

function encodeModifiedNamedKey(spec: string): Uint8Array | null {
  for (const [key, sequence] of Object.entries(modifiedNamedKeys)) {
    if (!spec.endsWith(`-${key}`)) continue;
    const modifiers = spec.slice(0, -(key.length + 1)).split("-");
    const unique = new Set(modifiers);
    if (
      modifiers.length === 0 ||
      unique.size !== modifiers.length ||
      modifiers.some(
        (modifier) => modifier !== "shift" && modifier !== "alt" && modifier !== "ctrl",
      )
    ) {
      continue;
    }
    const modifier =
      1 +
      (unique.has("shift") ? 1 : 0) +
      (unique.has("alt") ? 2 : 0) +
      (unique.has("ctrl") ? 4 : 0);
    return encoder.encode(`\x1b[${sequence.parameter};${modifier}${sequence.final}`);
  }
  return null;
}

function parseHex(value: string, context: string): Uint8Array {
  const compact = value.replace(/[\s:_-]/g, "");
  if (compact.length === 0 || compact.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(compact)) {
    throw new Error(`${context} must contain an even number of hexadecimal digits`);
  }

  const result = new Uint8Array(compact.length / 2);
  for (let index = 0; index < compact.length; index += 2) {
    result[index / 2] = Number.parseInt(compact.slice(index, index + 2), 16);
  }
  return result;
}

export function encodeKey(spec: string): Uint8Array {
  if (typeof spec !== "string" || spec.length === 0) {
    throw new Error("key names must be non-empty strings");
  }

  if (spec.toLowerCase().startsWith("hex:")) {
    return parseHex(spec.slice(4), `raw key ${JSON.stringify(spec)}`);
  }

  const normalized = spec.toLowerCase();
  const named = NAMED_KEY_ENCODINGS[normalized as keyof typeof NAMED_KEY_ENCODINGS];
  if (named !== undefined) return encoder.encode(named);

  const modifiedNamed = encodeModifiedNamedKey(normalized);
  if (modifiedNamed !== null) return modifiedNamed;

  if (normalized.startsWith("ctrl-")) {
    const key = normalized.slice(5);
    if (key === "space" || key === "@") return Uint8Array.of(0);
    const alias = controlAliases[key];
    if (alias !== undefined) return Uint8Array.of(alias);
    if (key.length === 1) {
      const code = key.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) return Uint8Array.of(code & 0x1f);
    }
    throw new Error(`unsupported control key ${JSON.stringify(spec)}`);
  }

  if (normalized.startsWith("alt-")) {
    const value = spec.slice(4);
    if (Array.from(value).length !== 1) {
      throw new Error(`Alt key ${JSON.stringify(spec)} must name one character`);
    }
    return concatBytes([Uint8Array.of(0x1b), encoder.encode(value)]);
  }

  if (Array.from(spec).length === 1) return encoder.encode(spec);
  throw new Error(`unknown key name ${JSON.stringify(spec)}`);
}

export function encodeKeys(keys: string[]): Uint8Array {
  return concatBytes(keys.map(encodeKey));
}

export function encodeRawHex(spec: string): Uint8Array {
  const value = spec.toLowerCase().startsWith("hex:") ? spec.slice(4) : spec;
  return parseHex(value, "bytes");
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function bytesKey(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Normalized key model: a mode-independent identity shared by binding names,
// legacy byte input, and Kitty-keyboard-protocol (CSI-u) input, so the matcher
// compares keys rather than raw bytes and a binding works no matter how the
// terminal encodes the keystroke. The legacy byte encoders above are unchanged.
// ---------------------------------------------------------------------------

export type KeyMods = { ctrl: boolean; alt: boolean; shift: boolean };
// A key's base token is either a single Unicode character ("d", "å") or one of
// the canonical named keys below.
export type Key = { name: string; mods: KeyMods };

// Under Kitty's REPORT_ALL_KEYS the terminal emits the modifier keys THEMSELVES as key
// events (left/right shift, control, alt, super, hyper, meta, and the two ISO-level
// shifts), using the Private-Use-Area codepoints 57441-57454. These are never part of a
// binding, so the matcher forwards them but must not let them break an in-progress chord
// (a user may release and re-press a modifier between the taps of a double-tap binding).
const MODIFIER_CODEPOINT_MIN = 0xe061; // 57441 = left shift
const MODIFIER_CODEPOINT_MAX = 0xe06e; // 57454 = ISO level5 shift
export function isModifierKey(key: Key): boolean {
  const chars = [...key.name];
  if (chars.length !== 1) return false; // named keys (e.g. "enter") are never modifiers
  const cp = chars[0]!.codePointAt(0)!;
  return cp >= MODIFIER_CODEPOINT_MIN && cp <= MODIFIER_CODEPOINT_MAX;
}
export type KeyEventType = "press" | "repeat" | "release";
export type DecodedKey = { key: Key; event: KeyEventType };
// The canonical, order-stable string used for matching, e.g. "ctrl+d", "shift+up".
export type KeyId = string;

const NO_MODS: KeyMods = { ctrl: false, alt: false, shift: false };
function withMods(base: KeyMods, extra: Partial<KeyMods>): KeyMods {
  return {
    ctrl: base.ctrl || !!extra.ctrl,
    alt: base.alt || !!extra.alt,
    shift: base.shift || !!extra.shift,
  };
}

const NAMED_ALIASES: Readonly<Record<string, string>> = {
  return: "enter",
  esc: "escape",
  ins: "insert",
  del: "delete",
  pgup: "page-up",
  pgdn: "page-down",
};

// Application-cursor keys keep an identity distinct from the normal cursor keys, so
// a binding configured as `app-up` matches only the legacy application-cursor bytes
// (ESC O A) and never ordinary Up (ESC [ A), and vice versa. Their base cursor key
// is used for the Kitty CSI-u representation, which has no such distinction.
const APP_CURSOR_TO_BASE: Readonly<Record<string, string>> = {
  "app-up": "up",
  "app-down": "down",
  "app-left": "left",
  "app-right": "right",
  "app-home": "home",
  "app-end": "end",
};
const NAMED_KEYS: ReadonlySet<string> = new Set([
  "enter",
  "tab",
  "escape",
  "backspace",
  "space",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "insert",
  "delete",
  "page-up",
  "page-down",
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
  "app-up",
  "app-down",
  "app-left",
  "app-right",
  "app-home",
  "app-end",
]);

// Functional keys and their CSI final byte + leading number (the "legacy
// functional" form Kitty also uses, e.g. Up = CSI 1 ; mods A, F5 = CSI 15 ; mods ~).
const FUNCTIONAL: Readonly<Record<string, { number: string; final: string }>> = {
  up: { number: "1", final: "A" },
  down: { number: "1", final: "B" },
  right: { number: "1", final: "C" },
  left: { number: "1", final: "D" },
  home: { number: "1", final: "H" },
  end: { number: "1", final: "F" },
  f1: { number: "1", final: "P" },
  f2: { number: "1", final: "Q" },
  // F3 is CSI 13 ~ in the Kitty protocol: CSI R would collide with the
  // cursor-position report, so the terminal never uses "1 R" for F3.
  f3: { number: "13", final: "~" },
  f4: { number: "1", final: "S" },
  insert: { number: "2", final: "~" },
  delete: { number: "3", final: "~" },
  "page-up": { number: "5", final: "~" },
  "page-down": { number: "6", final: "~" },
  f5: { number: "15", final: "~" },
  f6: { number: "17", final: "~" },
  f7: { number: "18", final: "~" },
  f8: { number: "19", final: "~" },
  f9: { number: "20", final: "~" },
  f10: { number: "21", final: "~" },
  f11: { number: "23", final: "~" },
  f12: { number: "24", final: "~" },
};
const FUNCTIONAL_BY_ENCODING = new Map<string, string>(
  Object.entries(FUNCTIONAL).map(([name, e]) => [`${e.number}${e.final}`, name]),
);

// Named keys that carry a Unicode codepoint in the CSI-u "u" form.
const NAME_TO_CODEPOINT: Readonly<Record<string, number>> = {
  enter: 13,
  tab: 9,
  escape: 27,
  backspace: 127,
  space: 32,
};
const CODEPOINT_TO_NAME = new Map<number, string>(
  Object.entries(NAME_TO_CODEPOINT).map(([name, cp]) => [cp, name]),
);

// The canonical base token for a bare codepoint: control-ish codepoints map to a
// named key, everything else is the character itself.
function codepointName(cp: number): string {
  return CODEPOINT_TO_NAME.get(cp) ?? String.fromCodePoint(cp);
}

// Build a Key from a codepoint + mods, normalizing an uppercase ASCII letter to
// its lowercase base plus the shift modifier (so "A", legacy 0x41, and Kitty
// shift+a all share one identity).
function charKey(cp: number, mods: KeyMods): Key {
  if (cp >= 0x41 && cp <= 0x5a) {
    return { name: String.fromCodePoint(cp + 0x20), mods: withMods(mods, { shift: true }) };
  }
  return { name: codepointName(cp), mods: { ...mods } };
}

export function keyId(key: Key): KeyId {
  const prefix =
    (key.mods.ctrl ? "ctrl+" : "") +
    (key.mods.alt ? "alt+" : "") +
    (key.mods.shift ? "shift+" : "");
  return prefix + key.name;
}

// The identity under which a key's PRESS is paired with its later repeats and release, so a
// consumed or held press settles against them. The Kitty modifier field carries the modifiers
// active AT EACH EVENT, and those can change while a key is held — e.g. Ctrl-D's press is
// `ctrl+d` but if Ctrl is released before D its release is plain `d`, and a modifier key's own
// bit is set on press and reset on its last release. keyId therefore changes across a key's
// lifecycle, so lifecycle bookkeeping must use a PHYSICAL identity — the base key itself, by
// name — independent of the transient held modifiers. The modifier-sensitive keyId is retained
// solely for chord matching.
export function lifecycleKeyId(key: Key): KeyId {
  return `key:${key.name}`;
}

// Parse the modifier prefixes of a "(shift|alt|ctrl)-...-base" spec; returns the
// mods and the trailing base token, or null if the modifier set is malformed.
function splitModifiers(spec: string): { mods: KeyMods; base: string } | null {
  const parts = spec.split("-");
  const base = parts.pop();
  if (base === undefined || base.length === 0) return null;
  const mods: KeyMods = { ...NO_MODS };
  const seen = new Set<string>();
  for (const part of parts) {
    if (seen.has(part)) return null;
    seen.add(part);
    if (part === "shift") mods.shift = true;
    else if (part === "alt") mods.alt = true;
    else if (part === "ctrl") mods.ctrl = true;
    else return null;
  }
  return { mods, base };
}

// Convert a binding key name (the same vocabulary encodeKey accepts) into its
// normalized Key identity.
export function parseKeyName(spec: string): Key {
  if (typeof spec !== "string" || spec.length === 0) {
    throw new Error("key names must be non-empty strings");
  }
  if (spec.toLowerCase().startsWith("hex:")) {
    const decoded = decodeLegacyKey(parseHex(spec.slice(4), `raw key ${JSON.stringify(spec)}`));
    if (decoded === null || decoded.consumed === 0 || decoded.token.kind !== "key") {
      throw new Error(`raw key ${JSON.stringify(spec)} does not encode a single key`);
    }
    return decoded.token.key;
  }

  const normalized = spec.toLowerCase();
  if (normalized === "shift-tab" || normalized === "backtab") {
    return { name: "tab", mods: { ...NO_MODS, shift: true } };
  }
  if (normalized in NAMED_ALIASES)
    return { name: NAMED_ALIASES[normalized]!, mods: { ...NO_MODS } };
  if (NAMED_KEYS.has(normalized)) return { name: normalized, mods: { ...NO_MODS } };

  const split = splitModifiers(normalized);
  if (split && (split.mods.shift || split.mods.alt || split.mods.ctrl)) {
    const { mods, base } = split;
    const canonicalBase = NAMED_ALIASES[base] ?? base;
    if (NAMED_KEYS.has(canonicalBase)) return { name: canonicalBase, mods };
    // The primary identity of a ctrl-<char> spec is the configured key itself
    // (ctrl+8, ctrl+2, ctrl+?, ctrl+@) -- what a Kitty terminal reports as CSI-u and
    // what `send` must emit. The ambiguous legacy control byte (0x7f, 0x00, ...) is
    // added only as a fallback ACCEPT identity in acceptSet(), not here.
    if (mods.ctrl && !mods.alt && !mods.shift && base === "space") {
      return { name: "space", mods: { ...NO_MODS, ctrl: true } };
    }
    const chars = Array.from(base);
    if (chars.length === 1) return charKey(chars[0]!.codePointAt(0)!, mods);
    throw new Error(`unsupported key ${JSON.stringify(spec)}`);
  }

  const chars = Array.from(spec);
  if (chars.length === 1) return charKey(chars[0]!.codePointAt(0)!, { ...NO_MODS });
  throw new Error(`unknown key name ${JSON.stringify(spec)}`);
}

// A single element of a compiled chord: the unit the matcher compares one decoded
// keystroke against. Named/character specs become an accept-set of the key ids the
// spec can legitimately arrive as (its Kitty-disambiguated identity plus its legacy
// identity, which may differ — ctrl-i is {ctrl+i, tab}). Exact-byte (`hex:`) specs
// stay exact byte sequences, so they match only the bytes requested, never a
// different encoding of the same logical key.
// `enhancedIds` are additional ids accepted only when a Kitty enhancement is active.
// They carry application-cursor bindings: `app-up` matches its distinct legacy SS3
// identity always, and the canonical base cursor (`up`) only under enhancement, where
// the protocol no longer provides a separate application-cursor encoding.
export type ChordElement =
  | {
      readonly kind: "ids";
      readonly ids: ReadonlySet<KeyId>;
      readonly enhancedIds?: ReadonlySet<KeyId>;
    }
  | { readonly kind: "bytes"; readonly bytes: Uint8Array };

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

// Does a decoded input keystroke satisfy this chord element? Matching considers the
// key's primary id and any alternate ids (base-layout / shifted, from flag 4), against
// the element's ids and — when `enhanced` (a canonicalizing flag is active) — its
// enhanced-only ids. Exact-byte elements compare the raw bytes.
export function chordElementMatches(
  element: ChordElement,
  unit: { id: KeyId; raw: Uint8Array; altIds?: readonly KeyId[] },
  enhanced: boolean,
): boolean {
  if (element.kind === "bytes") return bytesEqual(element.bytes, unit.raw);
  const candidates = unit.altIds ? [unit.id, ...unit.altIds] : [unit.id];
  for (const id of candidates) {
    if (element.ids.has(id)) return true;
    if (enhanced && element.enhancedIds?.has(id)) return true;
  }
  return false;
}

// The key ids a spec's legacy bytes decode to — i.e. how the key arrives in a
// terminal with no Kitty enhancements. ctrl-i's legacy byte 0x09 decodes to `tab`,
// ctrl-[ 's byte 0x1b is the Escape key, etc. This is what lets those documented
// aliases keep firing in a legacy terminal even though their disambiguated id differs.
function legacyKeyIds(spec: string): KeyId[] {
  let bytes: Uint8Array;
  try {
    bytes = encodeKey(spec);
  } catch {
    return [];
  }
  const ids: KeyId[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const result = decodeLegacyKey(bytes.subarray(offset));
    if (result === null) {
      // A trailing lone ESC (e.g. ctrl-[ -> 0x1b) is the Escape key in a legacy terminal.
      if (bytes.length - offset === 1 && bytes[offset] === 0x1b) ids.push("escape");
      break;
    }
    if (result.token.kind === "key") ids.push(keyId(result.token.key));
    offset += result.consumed;
  }
  return ids;
}

// The ids element for a named/character spec: its normalized identity plus the ids
// its legacy bytes decode to. An application-cursor spec additionally accepts its
// base cursor id, but only when a Kitty enhancement is active (enhancedIds).
function acceptElement(spec: string): ChordElement {
  const key = parseKeyName(spec);
  const ids = new Set<KeyId>([keyId(key)]);
  for (const id of legacyKeyIds(spec)) ids.add(id);
  const base = APP_CURSOR_TO_BASE[key.name];
  return base !== undefined
    ? { kind: "ids", ids, enhancedIds: new Set([base]) }
    : { kind: "ids", ids };
}

// Split a `hex:` spec into one exact-byte element per keystroke it encodes, so a
// documented multi-key raw chord (hex:026e == Ctrl-B, n) matches as two keystrokes
// rather than collapsing to only its first key.
function hexToElements(bytes: Uint8Array): ChordElement[] {
  const elements: ChordElement[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const result = decodeLegacyKey(bytes.subarray(offset));
    const consumed = result === null ? bytes.length - offset : result.consumed;
    elements.push({ kind: "bytes", bytes: bytes.slice(offset, offset + consumed) });
    offset += consumed;
  }
  if (elements.length === 0) elements.push({ kind: "bytes", bytes });
  return elements;
}

function specToElements(spec: string): ChordElement[] {
  if (spec.toLowerCase().startsWith("hex:")) {
    return hexToElements(parseHex(spec.slice(4), `raw key ${JSON.stringify(spec)}`));
  }
  return [acceptElement(spec)];
}

// Compile a binding's key entries into the chord the matcher runs on. A single entry
// may expand to several elements (a multi-key `hex:`).
export function compileChord(keys: string[]): ChordElement[] {
  return keys.flatMap(specToElements);
}

// A canonical string identity for a chord in the SAME domain the matcher uses, so
// app-config merging and unbinding target the identical chord (app-up and up share
// one identity; ctrl-8 and ctrl-? share one). Note this is exact identity, not the
// broader runtime ambiguity that chordsOverlap detects.
export function chordCanon(elements: readonly ChordElement[]): string {
  return elements
    .map((element) => {
      if (element.kind === "bytes") return `b:${bytesKey(element.bytes)}`;
      const ids = [...element.ids].sort().join("|");
      const enhanced = element.enhancedIds ? `^${[...element.enhancedIds].sort().join("|")}` : "";
      return ids + enhanced;
    })
    .join(" ");
}

// All ids an accept-set element can ever match, enhanced or not — used for ambiguity
// (overlap) detection, which must be mode-independent so a pair that clashes in ANY
// mode is caught at config time.
function allIds(element: {
  ids: ReadonlySet<KeyId>;
  enhancedIds?: ReadonlySet<KeyId>;
}): Set<KeyId> {
  const ids = new Set(element.ids);
  if (element.enhancedIds) for (const id of element.enhancedIds) ids.add(id);
  return ids;
}

function setsIntersect(a: ReadonlySet<KeyId>, b: ReadonlySet<KeyId>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const id of small) if (large.has(id)) return true;
  return false;
}

function elementsCompatible(a: ChordElement, b: ChordElement): boolean {
  if (a.kind === "ids" && b.kind === "ids") return setsIntersect(allIds(a), allIds(b));
  if (a.kind === "bytes" && b.kind === "bytes") return bytesEqual(a.bytes, b.bytes);
  const bytesEl = (a.kind === "bytes" ? a : b) as { kind: "bytes"; bytes: Uint8Array };
  const idsEl = a.kind === "ids" ? a : (b as Extract<ChordElement, { kind: "ids" }>);
  // An exact-byte element and an accept-set element overlap when those exact bytes
  // decode to a key the accept-set would also match (hex:026e vs ctrl-b,n).
  const decoded = decodeLegacyKey(bytesEl.bytes);
  if (
    decoded === null ||
    decoded.token.kind !== "key" ||
    decoded.consumed !== bytesEl.bytes.length
  ) {
    return false;
  }
  return allIds(idsEl).has(keyId(decoded.token.key));
}

// Whether two chords can be satisfied by the same input at runtime (same length and
// every position compatible). Duplicate detection uses this — not mere canonical
// equality — so ambiguous pairs like hex:026e and ctrl-b,n are caught even though
// their canonical identities differ. Chords of different length never overlap: a
// shorter chord that is a prefix of a longer one is the intended prefix-hold.
export function chordsOverlap(a: readonly ChordElement[], b: readonly ChordElement[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (!elementsCompatible(a[index]!, b[index]!)) return false;
  }
  return true;
}

// A single decoded unit from an input stream: either a normalized key press, or
// a run of bytes that is not a key (mouse report, query reply, unknown escape)
// and must be forwarded to the child verbatim.
export type InputToken =
  | {
      kind: "key";
      key: Key;
      event: KeyEventType;
      raw: Uint8Array;
      // Additional identities a Kitty CSI-u key may be matched against for shortcuts:
      // its base-layout key (layout-independent) and, when Shift is held, its shifted
      // key (report-alternate-keys, flag 4). The forwarded raw bytes are unchanged.
      altIds?: readonly KeyId[];
    }
  | { kind: "raw"; raw: Uint8Array };
type DecodeResult = { consumed: number; token: InputToken };

const decoder = new TextDecoder();

function utf8Length(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc0 && lead < 0xe0) return 2;
  if (lead >= 0xe0 && lead < 0xf0) return 3;
  if (lead >= 0xf0 && lead < 0xf8) return 4;
  return 1; // stray continuation/invalid byte: consume one
}

// The functional key for a numeric parameter + final byte, requiring an EXACT match
// of the defined grammar. An empty number is the implied "1" (e.g. bare CSI A = Up),
// but any other number must be exactly the one defined for that final — CSI 999 A is
// not Up. There is no implied-1 fallback that ignores a supplied number.
function functionalName(number: string, final: string): string | undefined {
  return FUNCTIONAL_BY_ENCODING.get(`${number === "" ? "1" : number}${final}`);
}

// Parse a CSI-u unicode-key-code field (its first ":"-subfield) into a validated
// Unicode scalar value, or null when the grammar is wrong or the value is not a
// scalar (negative, out of range, or a lone surrogate). Untrusted terminal input
// must never reach String.fromCodePoint with an illegal value.
function parseCodepoint(field: string): number | null {
  if (!/^\d+$/.test(field)) return null;
  const cp = Number.parseInt(field, 10);
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return null;
  if (cp >= 0xd800 && cp <= 0xdfff) return null; // lone surrogate: not a scalar
  return cp;
}

// Parse the CSI "modifiers[:event]" field. Returns null on malformed grammar, on
// unsupported modifier bits (super/hyper/meta, or junk beyond the defined set), or
// on an unknown event type, so the caller forwards the sequence raw rather than
// inventing a key. Ambient caps-lock / num-lock bits are ignored, not rejected.
function parseModsEvent(field: string | undefined): { mods: KeyMods; event: KeyEventType } | null {
  if (field === undefined || field === "") return { mods: { ...NO_MODS }, event: "press" };
  const parts = field.split(":");
  if (parts.length > 2) return null;
  const [modStr, eventStr] = parts;
  if (!/^\d+$/.test(modStr ?? "")) return null;
  const value = Number.parseInt(modStr!, 10);
  if (value < 1 || value > 0xffff) return null;
  const bits = (value - 1) & ~(64 | 128); // drop caps-lock / num-lock ambient state
  if ((bits & ~(1 | 2 | 4)) !== 0) return null; // super/hyper/meta (or junk): cannot represent
  const mods: KeyMods = { shift: (bits & 1) !== 0, alt: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 };
  if (eventStr === undefined) return { mods, event: "press" }; // no event subfield
  // A colon was present, so an explicit event value is required (an empty one is
  // malformed, not an implicit press).
  if (eventStr === "1") return { mods, event: "press" };
  if (eventStr === "2") return { mods, event: "repeat" };
  if (eventStr === "3") return { mods, event: "release" };
  return null; // empty or unknown event type
}

// Every colon-separated codepoint in an alternate-key or associated-text field must
// be a valid scalar (an omitted "" subfield is allowed), and the count must not
// exceed `maxParts` when given. A malformed subfield or excess subfield makes the
// whole sequence raw rather than letting an ignored field smuggle in a key.
function validCodepointSubfields(field: string, skipFirst: boolean, maxParts?: number): boolean {
  const parts = field.split(":");
  if (maxParts !== undefined && parts.length > maxParts) return false;
  for (let index = skipFirst ? 1 : 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part !== "" && parseCodepoint(part) === null) return false;
  }
  return true;
}

// The associated-text field is one or more codepoints, none of which may be a control
// (C0 0x00-0x1f, DEL 0x7f, or C1 0x80-0x9f) — the protocol forbids control text.
function validAssociatedText(field: string): boolean {
  for (const part of field.split(":")) {
    if (part === "") continue;
    const cp = parseCodepoint(part);
    if (cp === null) return false;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return false;
  }
  return true;
}

function keyFromCodepoint(cp: number, mods: KeyMods): Key {
  const named = CODEPOINT_TO_NAME.get(cp);
  if (named !== undefined) return { name: named, mods: { ...mods } };
  return charKey(cp, mods);
}

// Decode a complete CSI sequence (bytes[0..1] == ESC '[') into a key token, or a
// raw passthrough token for non-key CSI (mouse, query replies, private modes).
// Returns null when the sequence is not yet complete.
function decodeCsi(buf: Uint8Array): DecodeResult | null {
  let i = 2;
  while (i < buf.length && buf[i]! >= 0x20 && buf[i]! <= 0x3f) i += 1; // params + intermediates
  if (i >= buf.length) return null; // final byte not arrived yet
  const finalByte = buf[i]!;
  const end = i + 1;
  const seq = buf.subarray(0, end);
  if (finalByte < 0x40 || finalByte > 0x7e)
    return { consumed: end, token: { kind: "raw", raw: seq } };

  const paramStr = decoder.decode(buf.subarray(2, i));
  const finalCh = String.fromCharCode(finalByte);
  // Private/query/mouse/cursor forms are not keys: pass them through untouched
  // (e.g. the terminal's `CSI ? flags u` reply to the child's progressive-enhancement query).
  if (/^[?<>=]/.test(paramStr) || finalCh === "M" || finalCh === "m" || finalCh === "R") {
    return { consumed: end, token: { kind: "raw", raw: seq } };
  }
  const params = paramStr.split(";");
  const raw = { consumed: end, token: { kind: "raw", raw: seq } } as const;

  if (finalCh === "u") {
    // Full grammar: key-codepoints[:alt...] ; modifiers[:event] ; text-codepoints[:...]
    if (params.length > 3) return raw;
    const keySubs = (params[0] ?? "").split(":");
    const cp = parseCodepoint(keySubs[0] ?? "");
    if (cp === null) return raw;
    // key codepoint plus at most shifted + base-layout alternates (3 subfields).
    if (!validCodepointSubfields(params[0] ?? "", true, 3)) return raw;
    const parsed = parseModsEvent(params[1]);
    if (parsed === null) return raw;
    // A shifted-key alternate (subfield 1) is only valid when Shift is actually held.
    if (keySubs[1] !== undefined && keySubs[1] !== "" && !parsed.mods.shift) return raw;
    // Associated text may not contain control codepoints.
    if (params[2] !== undefined && !validAssociatedText(params[2])) return raw;
    // Alternate-key ids (flag 4): the base-layout key gives layout-independent shortcut
    // matching; the shifted key (Shift held) already encodes the shift, so match it
    // without the Shift modifier. These are extra match candidates only — the raw
    // bytes forwarded on a miss are unchanged.
    const altIds: KeyId[] = [];
    const base = keySubs[2] ? parseCodepoint(keySubs[2]) : null;
    const shifted = keySubs[1] ? parseCodepoint(keySubs[1]) : null;
    if (base !== null) altIds.push(keyId(keyFromCodepoint(base, parsed.mods)));
    if (shifted !== null && parsed.mods.shift) {
      altIds.push(keyId(keyFromCodepoint(shifted, { ...parsed.mods, shift: false })));
    }
    return {
      consumed: end,
      token: {
        kind: "key",
        key: keyFromCodepoint(cp, parsed.mods),
        event: parsed.event,
        raw: seq,
        ...(altIds.length > 0 ? { altIds } : {}),
      },
    };
  }

  // Functional keys: bare `CSI [number] final` or modified `CSI number ; modifiers
  // final`. The numeric field has no alternate-key subfields (those belong to the `u`
  // form). An explicitly empty semicolon field is not a valid substitute: the modified
  // form requires both a leading number and a modifier value.
  if (params.length > 2) return raw;
  if ((params[0] ?? "").includes(":")) return raw;
  if (params.length === 2 && (params[0] === "" || params[1] === "")) return raw;
  // A letter-final functional key is bare (CSI A) when unmodified: a lone numeric
  // field with no modifier (CSI 1 A) is not a valid form. Tilde-final keys are the
  // separate production that DOES require an unmodified numeric parameter (CSI 15 ~).
  if (params.length === 1 && finalCh !== "~" && params[0] !== "") return raw;
  const name = functionalName(params[0] ?? "", finalCh);
  if (name === undefined) return raw;
  const parsed = parseModsEvent(params[1]);
  if (parsed === null) return raw;
  return {
    consumed: end,
    token: { kind: "key", key: { name, mods: parsed.mods }, event: parsed.event, raw: seq },
  };
}

// SS3 (ESC O <final>) is the legacy application-cursor form. The arrows/home/end are
// kept distinct from their normal-cursor (CSI) identity so an `app-up` binding does
// not fire on ordinary Up; F1-F4 have no such ambiguity.
const SS3_FINALS: Readonly<Record<string, string>> = {
  A: "app-up",
  B: "app-down",
  C: "app-right",
  D: "app-left",
  H: "app-home",
  F: "app-end",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
};

// Decode one key (or one raw unit) from the START of `buf`. Returns null when
// more bytes are needed to complete a sequence (the caller buffers). A lone ESC
// is intentionally left incomplete so the caller can resolve it on idle timeout.
export function decodeLegacyKey(buf: Uint8Array): DecodeResult | null {
  if (buf.length === 0) return null;
  const b0 = buf[0]!;

  if (b0 === 0x1b) {
    if (buf.length === 1) return null; // lone ESC: resolved by timeout upstream
    if (buf[1] === 0x5b) return decodeCsi(buf); // CSI
    if (buf[1] === 0x4f) {
      if (buf.length < 3) return null;
      const name = SS3_FINALS[String.fromCharCode(buf[2]!)];
      const seq = buf.subarray(0, 3);
      if (name === undefined) return { consumed: 3, token: { kind: "raw", raw: seq } };
      return {
        consumed: 3,
        token: { kind: "key", key: { name, mods: { ...NO_MODS } }, event: "press", raw: seq },
      };
    }
    // ESC + char => Alt+<char>
    const len = 1 + utf8Length(buf[1]!);
    if (buf.length < len) return null;
    const ch = decoder.decode(buf.subarray(1, len));
    const cp = ch.codePointAt(0);
    if (cp === undefined)
      return { consumed: len, token: { kind: "raw", raw: buf.subarray(0, len) } };
    return {
      consumed: len,
      token: {
        kind: "key",
        key: charKey(cp, { ...NO_MODS, alt: true }),
        event: "press",
        raw: buf.subarray(0, len),
      },
    };
  }

  if (b0 === 0x0d) return controlKey(buf, "enter", {});
  if (b0 === 0x09) return controlKey(buf, "tab", {});
  if (b0 === 0x7f) return controlKey(buf, "backspace", {});
  if (b0 === 0x00) return controlKey(buf, "space", { ctrl: true });
  if (b0 >= 0x01 && b0 <= 0x1f) {
    const letter = String.fromCharCode(b0 | 0x40); // 0x04 -> 'D'
    const name = /[A-Z]/.test(letter) ? letter.toLowerCase() : letter;
    return controlKey(buf, name, { ctrl: true });
  }

  // printable / UTF-8 character
  const len = utf8Length(b0);
  if (buf.length < len) return null;
  const ch = decoder.decode(buf.subarray(0, len));
  const cp = ch.codePointAt(0);
  if (cp === undefined) return { consumed: len, token: { kind: "raw", raw: buf.subarray(0, len) } };
  return {
    consumed: len,
    token: {
      kind: "key",
      key: charKey(cp, { ...NO_MODS }),
      event: "press",
      raw: buf.subarray(0, len),
    },
  };
}

function controlKey(buf: Uint8Array, name: string, extra: Partial<KeyMods>): DecodeResult {
  return {
    consumed: 1,
    token: {
      kind: "key",
      key: { name, mods: withMods(NO_MODS, extra) },
      event: "press",
      raw: buf.subarray(0, 1),
    },
  };
}

// ---- encoding a normalized key back to bytes, for `send` actions ----

function modParam(mods: KeyMods): number {
  return 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
}

// The CSI-u / Kitty form of a key (what a terminal in "report all keys" mode sends).
// Application-cursor keys collapse to their base cursor key, since the Kitty protocol
// does not distinguish application from normal cursor.
export function encodeCsiU(key: Key): Uint8Array {
  const m = modParam(key.mods);
  const name = APP_CURSOR_TO_BASE[key.name] ?? key.name;
  const functional = FUNCTIONAL[name];
  if (functional !== undefined) {
    if (m === 1) {
      return encoder.encode(
        functional.final === "~" ? `\x1b[${functional.number}~` : `\x1b[${functional.final}`,
      );
    }
    return encoder.encode(`\x1b[${functional.number};${m}${functional.final}`);
  }
  const cp = NAME_TO_CODEPOINT[name] ?? name.codePointAt(0) ?? 0;
  return encoder.encode(m === 1 ? `\x1b[${cp}u` : `\x1b[${cp};${m}u`);
}

// Rebuild the binding-name spec for a key so the legacy encoder can produce its
// classic bytes (ctrl-d -> 0x04, up -> ESC[A, shift+a -> "A").
function keyToSpec(key: Key): string {
  const { name, mods } = key;
  if (mods.shift && !mods.ctrl && !mods.alt && /^[a-z]$/.test(name)) return name.toUpperCase();
  const prefix =
    (mods.ctrl ? "ctrl-" : "") + (mods.alt ? "alt-" : "") + (mods.shift ? "shift-" : "");
  return prefix + name;
}

export function encodeKeyLegacy(key: Key): Uint8Array {
  return encodeKey(keyToSpec(key));
}

const TEXT_NAMED: ReadonlySet<string> = new Set(["enter", "tab", "backspace", "space"]);

// A key "produces text" — keeping its legacy byte encoding and NOT being reported as
// an escape code — when it has no ctrl/alt modifier and is either a single printable
// character or one of Enter/Tab/Backspace/Space. Everything else (Escape, functional
// keys, application-cursor, and any ctrl/alt combination) is an escape-code key.
function producesText(key: Key): boolean {
  if (key.mods.ctrl || key.mods.alt) return false;
  if (TEXT_NAMED.has(key.name)) return true;
  return [...key.name].length === 1;
}

// Whether a key must be emitted as CSI-u/functional given the child's negotiated
// Kitty flags. flag 8 (report all keys) enhances every key. flag 1 (disambiguate)
// enhances every NON-text key — not only ctrl/alt/Escape but also functional and
// application-cursor keys, which the protocol requires in unambiguous CSI form.
function needsCsiU(key: Key, flags: number): boolean {
  if ((flags & KITTY_REPORT_ALL_KEYS) !== 0) return true;
  if ((flags & KITTY_DISAMBIGUATE) !== 0) return !producesText(key);
  return false;
}

// Whether the terminal reports a key-release for this key under the given flags.
// Releases require event-type reporting (flag 2); under flag 8 every key gets them,
// under flag 2 alone only escape-code (non-text) keys do. Used so release bookkeeping
// never owes a release the terminal will not actually send (Enter/Tab/text under
// flag 2 without flag 8).
export function keyReportsRelease(key: Key, flags: number): boolean {
  if ((flags & KITTY_REPORT_EVENT_TYPES) === 0) return false;
  if ((flags & KITTY_REPORT_ALL_KEYS) !== 0) return true;
  return !producesText(key);
}

// Encode one `send` key spec in whatever mode the child has negotiated. Exact-byte
// (`hex:`) specs are always sent verbatim. Otherwise: CSI-u when the active flags
// require it, else the spec's own legacy bytes — which preserves app-cursor spellings
// (app-up -> ESC O A) that a semantic re-encode would flatten to a normal cursor key.
export function encodeKeyActive(key: Key, flags: number): Uint8Array {
  return needsCsiU(key, flags) ? encodeCsiU(key) : encodeKeyLegacy(key);
}

function encodeSpecActive(spec: string, flags: number): Uint8Array {
  if (spec.toLowerCase().startsWith("hex:")) return encodeRawHex(spec);
  const key = parseKeyName(spec);
  return needsCsiU(key, flags) ? encodeCsiU(key) : encodeKey(spec);
}

export function encodeKeysActive(keys: string[], flags: number): Uint8Array {
  return concatBytes(keys.map((spec) => encodeSpecActive(spec, flags)));
}
