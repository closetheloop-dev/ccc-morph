import { InputDecoder } from "./input-decode";
import {
  type ChordElement,
  chordElementMatches,
  decodeLegacyKey,
  type InputToken,
  isModifierKey,
  type Key,
  type KeyId,
  keyId,
  keyReportsRelease,
  lifecycleKeyId,
} from "./keys";
import { KITTY_DISAMBIGUATE, KITTY_REPORT_ALL_KEYS } from "./kitty";
import type { CompiledBinding } from "./types";

// The flags that actually canonicalize functional/cursor input (dropping the legacy
// application-cursor SS3 distinction): disambiguate and report-all-keys. The passive
// flags (alternate-keys 4, associated-text 16, event-types 2) do not, so they must
// not unlock an app-cursor binding's enhanced-only id.
const ENHANCING_FLAGS = KITTY_DISAMBIGUATE | KITTY_REPORT_ALL_KEYS;

type Forward = (bytes: Uint8Array) => void;
type Match = (binding: CompiledBinding) => void;

// The id given to a non-key (raw) input unit. It is a plain-text value no real key
// id can equal (parseKeyName/keyId never produce it), so a raw unit never satisfies
// an accept-set element — only an exact-byte element — while still being able to sit
// in the pending chord and be forwarded when unmatched.
const RAW_ID = "raw-sequence";

// A pending input unit: a decoded key's canonical id plus the exact bytes it
// arrived as (so unmatched input is forwarded to the child verbatim). `key` is the
// decoded key (absent for raw units), used to decide release bookkeeping. `release`
// and `repeats` hold the key's later release/repeat-event bytes while the press is
// still part of an in-progress chord, so they settle with the press they belong to.
// Every input event is a positioned unit, so passthrough always emits in arrival order.
// A press/raw unit is REAL (participates in chord matching). A transparent unit — a lone
// modifier press, or any key's repeat/release — is ignored by chord comparison but keeps its
// position. A repeat/release carries the physical lifecycle id of the key it belongs to, so it
// is swallowed if that key's press was consumed (owed) and forwarded otherwise.
type Unit = {
  id: KeyId;
  raw: Uint8Array;
  key?: Key;
  altIds?: readonly KeyId[];
  transparent?: boolean;
  // Set on repeat/release units: the owning key's physical lifecycle id (stable across held-
  // modifier changes) and which lifecycle event this is (a release settles one owed unit).
  lifeId?: KeyId;
  lifecycle?: "release" | "repeat";
};

function chordStartsWith(
  chord: readonly ChordElement[],
  pending: readonly Unit[],
  enhanced: boolean,
): boolean {
  if (pending.length > chord.length) return false;
  for (let index = 0; index < pending.length; index += 1) {
    if (!chordElementMatches(chord[index]!, pending[index]!, enhanced)) return false;
  }
  return true;
}

function pendingStartsWith(
  pending: readonly Unit[],
  chord: readonly ChordElement[],
  enhanced: boolean,
): boolean {
  if (chord.length > pending.length) return false;
  for (let index = 0; index < chord.length; index += 1) {
    if (!chordElementMatches(chord[index]!, pending[index]!, enhanced)) return false;
  }
  return true;
}

// Matches configured key chords against a stream of decoded key events, holding a
// prefix until a `sequence_timeout_ms` timer or a diverging key resolves it.
// Bindings match on their compiled `chord` (accept-sets / exact bytes), so a chord
// fires whether the terminal sent legacy bytes or Kitty CSI-u for those keys.
//
// Key events carry a lifecycle when the child enables Kitty's event-type reporting
// (press / repeat / release). Only presses drive chord matching; a release never
// settles a pending chord (so a double-tap survives the release between the taps),
// and the release of a press the wrapper consumed is swallowed rather than leaked
// to the child. Unmatched keys keep their press+release paired so a passed-through
// key still looks balanced to the child.
export class ShortcutMatcher {
  readonly #bindings: readonly CompiledBinding[];
  readonly #timeoutMs: number;
  readonly #forward: Forward;
  readonly #match: Match;
  #pending: Unit[] = [];
  // Per-key count of releases still owed to consumed presses (with the key that owes
  // them, so a flag change can keep debt the new mode still reports). Those releases
  // must be swallowed instead of forwarded so the child sees no orphan release event.
  readonly #swallowRelease = new Map<KeyId, { count: number; key: Key }>();
  // The child's negotiated Kitty flags. Whether a release is owed depends on these
  // plus the key's class (see keyReportsRelease); whether the terminal drops the
  // application-cursor distinction (enhanced matching) depends on any flag being set.
  #flags = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    bindings: readonly CompiledBinding[],
    timeoutMs: number,
    forward: Forward,
    match: Match,
  ) {
    this.#bindings = bindings;
    this.#timeoutMs = timeoutMs;
    this.#forward = forward;
    this.#match = match;
  }

  // Decode complete byte input into keys and feed them (used directly by tests;
  // production feeds pre-decoded tokens through the InputRouter). Legacy bytes only
  // ever produce press events, so this path never exercises release handling.
  feed(bytes: Uint8Array): void {
    const tokens: InputToken[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      const result = decodeLegacyKey(bytes.subarray(offset));
      if (result === null) break;
      tokens.push(result.token);
      offset += result.consumed;
    }
    if (offset < bytes.length) tokens.push({ kind: "raw", raw: bytes.subarray(offset) });
    this.feedKeys(tokens);
  }

  feedKeys(tokens: readonly InputToken[]): void {
    for (const token of tokens) {
      if (token.kind !== "key") {
        // A non-key run (mouse report, unknown escape) is a real pending unit too, so an
        // exact-byte (hex:) binding can match a sequence the semantic decoder does not
        // recognize. It never matches an accept-set element, and if nothing matches it is
        // forwarded verbatim like any unmatched input.
        this.#pending.push({ id: RAW_ID, raw: token.raw });
        this.#evaluate();
      } else if (token.event === "press" && !isModifierKey(token.key)) {
        this.#pending.push({
          id: keyId(token.key),
          key: token.key,
          raw: token.raw,
          altIds: token.altIds,
        });
        this.#evaluate();
      } else {
        // A modifier press, or ANY key's repeat/release, is a TRANSPARENT positioned unit: it
        // keeps its exact position so passthrough preserves byte order, but is ignored by chord
        // comparison. A repeat/release carries the owning key's physical lifecycle id so it is
        // swallowed when that press was consumed (see #emit). Because it does not change the
        // real chord, it must NOT restart the pending prefix's deadline, so it is evaluated only
        // when no real prefix is waiting (a lone/settled event to forward immediately).
        const unit: Unit = { id: RAW_ID, raw: token.raw, transparent: true };
        if (token.event !== "press") {
          unit.lifeId = lifecycleKeyId(token.key);
          unit.lifecycle = token.event;
        }
        this.#pending.push(unit);
        if (this.#realPending().length === 0) this.#evaluate();
      }
    }
  }

  // Forward a pending unit, or swallow it if it is a repeat/release owed to a consumed press
  // (matched by physical lifecycle id; a release settles one owed unit, a repeat does not).
  #emit(unit: Unit): void {
    if (unit.lifecycle !== undefined && unit.lifeId !== undefined) {
      const entry = this.#swallowRelease.get(unit.lifeId);
      if (entry !== undefined && entry.count > 0) {
        if (unit.lifecycle === "release") {
          entry.count -= 1;
          if (entry.count === 0) this.#swallowRelease.delete(unit.lifeId);
        }
        return; // owned by a consumed press: swallowed, not leaked to the child
      }
    }
    this.#forward(unit.raw);
  }

  // Update the child's negotiated Kitty flags. Owed-release debt is kept when the new
  // mode still reports a release for that key, and discarded only when it no longer
  // can be satisfied — so an unrelated flag toggle (e.g. alternate-keys 4) does not
  // drop a real debt, but a transition that stops reporting a key's release does.
  setFlags(flags: number): void {
    if (flags === this.#flags) return;
    this.#flags = flags;
    for (const [id, entry] of this.#swallowRelease) {
      // Discard a debt only when the new mode can no longer report that release AND no such
      // release is already queued. A release already generated under the old mode still exists
      // and must remain owed, so a later flag change cannot orphan it.
      if (!keyReportsRelease(entry.key, flags) && !this.#hasQueuedRelease(id)) {
        this.#swallowRelease.delete(id);
      }
    }
  }

  #hasQueuedRelease(lifeId: KeyId): boolean {
    return this.#pending.some((unit) => unit.lifecycle === "release" && unit.lifeId === lifeId);
  }

  // Whether a release for `lifeId` is already queued at or beyond `start` (i.e. it arrived while
  // this press was pending and belongs to it, not to an earlier already-processed press).
  #queuedReleaseAfter(lifeId: KeyId, start: number): boolean {
    for (let index = start; index < this.#pending.length; index += 1) {
      const unit = this.#pending[index]!;
      if (unit.lifecycle === "release" && unit.lifeId === lifeId) return true;
    }
    return false;
  }

  // Register that a key's press was consumed elsewhere (a wrapper viewer, while a
  // modal owns the screen) so this matcher swallows the matching release when it
  // arrives — keeping release bookkeeping correct across modal transitions. Only owed
  // when the terminal will actually report a release for this key.
  oweRelease(key: Key): void {
    if (!keyReportsRelease(key, this.#flags)) return;
    this.#owe(key);
  }

  #owe(key: Key): void {
    const id = lifecycleKeyId(key);
    const entry = this.#swallowRelease.get(id);
    if (entry) entry.count += 1;
    else this.#swallowRelease.set(id, { count: 1, key });
  }

  flushPending(): void {
    this.#clearTimer();
    while (this.#pending.length > 0) {
      const real = this.#realPending();
      if (real.length === 0) {
        this.#drainAll(); // only transparent (modifier) events remain: forward them in order
        return;
      }
      const completed = this.#longestCompletedPrefix(real);
      if (!completed) {
        this.#drainAll(); // nothing matches: forward everything in order
        return;
      }
      this.#take(completed.chord.length, true);
      this.#match(completed);
    }
  }

  dispose(): void {
    this.flushPending();
  }

  // The pending units that participate in chord comparison. Transparent modifier events are
  // positional-only and excluded, so a modifier interleaved between chord elements neither
  // extends nor breaks the chord.
  #realPending(): Unit[] {
    return this.#pending.filter((unit) => unit.transparent !== true);
  }

  // Resolve the first `realCount` REAL pending units from the front, plus any transparent
  // units interspersed among or before them, preserving byte order. Transparent units are
  // emitted (a repeat/release owed to one of the consumed presses is swallowed by #emit). Real
  // units are consumed (`consumed`: their bytes dropped and their release owed, so the release
  // unit that arrives later or sits further back is swallowed) or passed through otherwise.
  // Everything walked is removed from the queue.
  #take(realCount: number, consumed: boolean): void {
    let index = 0;
    let seen = 0;
    while (index < this.#pending.length && seen < realCount) {
      const unit = this.#pending[index]!;
      if (unit.transparent === true) {
        this.#emit(unit);
      } else {
        seen += 1;
        if (consumed) {
          // Owe this press's release so the matching release unit is swallowed. Owe when the
          // release is ALREADY QUEUED (it was generated under the old mode and must be
          // suppressed regardless of the flags now), OR when the CURRENT mode will still report
          // a future release. Do not owe a future release the current mode won't send, so a
          // stale debt cannot later swallow an unrelated key's release.
          if (
            unit.key !== undefined &&
            (this.#queuedReleaseAfter(lifecycleKeyId(unit.key), index + 1) ||
              keyReportsRelease(unit.key, this.#flags))
          ) {
            this.#owe(unit.key);
          }
        } else {
          this.#forward(unit.raw);
        }
      }
      index += 1;
    }
    this.#pending.splice(0, index);
  }

  // Forward every pending unit in arrival order and clear the queue (used when nothing can
  // match). Repeats/releases owed to a consumed press are still swallowed by #emit.
  #drainAll(): void {
    for (const unit of this.#pending) {
      if (unit.transparent === true) this.#emit(unit);
      else this.#forward(unit.raw);
    }
    this.#pending = [];
  }

  // Whether the terminal drops the application-cursor SS3 distinction, so app-cursor
  // bindings match the canonical base cursor id. Only the canonicalizing flags do
  // this, not the passive alternate-keys / associated-text bits.
  get #enhanced(): boolean {
    return (this.#flags & ENHANCING_FLAGS) !== 0;
  }

  #evaluate(): void {
    this.#clearTimer();

    while (this.#pending.length > 0) {
      const real = this.#realPending();
      if (real.length === 0) {
        this.#drainAll(); // only transparent (modifier) events pending: forward them
        return;
      }
      const candidates = this.#bindings.filter((binding) =>
        chordStartsWith(binding.chord, real, this.#enhanced),
      );
      if (candidates.length === 0) {
        const completed = this.#longestCompletedPrefix(real);
        if (completed) {
          this.#take(completed.chord.length, true);
          this.#match(completed);
          continue;
        }
        this.#take(1, false); // pass through the first real unit (and any leading transparent)
        continue;
      }

      const exact = candidates.find((binding) => binding.chord.length === real.length);
      const hasLonger = candidates.some((binding) => binding.chord.length > real.length);
      if (exact && !hasLonger) {
        this.#take(exact.chord.length, true);
        this.#match(exact);
        continue;
      }

      this.#timer = setTimeout(() => this.#expire(), this.#timeoutMs);
      return;
    }
  }

  #expire(): void {
    this.#timer = null;
    const real = this.#realPending();
    const exact = this.#bindings.find(
      (binding) =>
        binding.chord.length === real.length &&
        chordStartsWith(binding.chord, real, this.#enhanced),
    );
    if (exact) {
      this.#take(exact.chord.length, true);
      this.#match(exact);
      this.#drainAll(); // forward any trailing transparent (modifier) suffix the match unblocked
      return;
    }
    this.flushPending();
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #longestCompletedPrefix(real: readonly Unit[]): CompiledBinding | undefined {
    let longest: CompiledBinding | undefined;
    for (const binding of this.#bindings) {
      if (
        pendingStartsWith(real, binding.chord, this.#enhanced) &&
        (!longest || binding.chord.length > longest.chord.length)
      ) {
        longest = binding;
      }
    }
    return longest;
  }
}

const PASTE_START = Uint8Array.from([0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]);
const PASTE_END = Uint8Array.from([0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]);

function isPrefix(value: readonly number[], marker: Uint8Array): boolean {
  if (value.length > marker.length) return false;
  return value.every((byte, index) => marker[index] === byte);
}

// Where the router sends what it decodes. `keys` receives decoded key tokens (and
// non-key raw runs); `paste` receives bracketed-paste content and markers to be
// forwarded verbatim; `beforePaste` lets the current consumer settle before a paste
// block begins. The session routes `keys` to a wrapper viewer or the shortcut
// matcher depending on whether a modal is open, so input is decoded exactly once.
export type RouterSink = {
  keys(tokens: InputToken[]): void;
  paste(bytes: Uint8Array): void;
  beforePaste(): void;
  dispose?(): void;
};

/**
 * Keeps bracketed-paste bytes out of shortcut matching (byte-level, since paste
 * content may contain key-looking bytes), and decodes non-paste input into key
 * tokens before handing them to the sink.
 */
export class InputRouter {
  readonly #sink: RouterSink;
  readonly #probeTimeoutMs: number;
  readonly #decoder = new InputDecoder();
  #inPaste = false;
  #probe: number[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(sink: RouterSink, probeTimeoutMs = 25) {
    this.#sink = sink;
    this.#probeTimeoutMs = probeTimeoutMs;
  }

  feed(bytes: Uint8Array): void {
    this.#clearTimer();
    for (const byte of bytes) this.#accept(byte);
    if (this.#probe.length > 0 || this.#decoder.hasPending()) {
      this.#timer = setTimeout(() => this.#flushIdle(), this.#probeTimeoutMs);
    }
  }

  dispose(): void {
    this.#clearTimer();
    this.#flushIdle();
    this.#sink.dispose?.();
  }

  #accept(byte: number): void {
    const marker = this.#inPaste ? PASTE_END : PASTE_START;
    this.#probe.push(byte);

    while (this.#probe.length > 0 && !isPrefix(this.#probe, marker)) {
      const first = this.#probe.shift()!;
      if (this.#inPaste) this.#sink.paste(Uint8Array.of(first));
      else this.#sink.keys(this.#decoder.feed(Uint8Array.of(first)));
    }

    if (this.#probe.length === marker.length) {
      if (!this.#inPaste) this.#sink.beforePaste();
      this.#sink.paste(Uint8Array.from(this.#probe));
      this.#probe = [];
      this.#inPaste = !this.#inPaste;
    }
  }

  #flushIdle(): void {
    this.#clearTimer();
    if (this.#probe.length > 0) {
      const bytes = Uint8Array.from(this.#probe);
      this.#probe = [];
      if (this.#inPaste) this.#sink.paste(bytes);
      else this.#sink.keys(this.#decoder.feed(bytes));
    }
    if (this.#decoder.hasPending()) this.#sink.keys(this.#decoder.flush());
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
