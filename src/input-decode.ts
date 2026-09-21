import { concatBytes, decodeLegacyKey, type InputToken } from "./keys";

// Turns a stdin byte stream into a sequence of tokens: normalized key presses
// (decoded from either legacy bytes or Kitty CSI-u sequences) and `raw` runs that
// are not keys (mouse reports, query replies, unknown escapes) and must be
// forwarded to the child untouched. Chunk-split safe: an incomplete trailing
// sequence is buffered until the next feed, or resolved by flush() on idle.
export class InputDecoder {
  #carry = new Uint8Array(0);

  feed(bytes: Uint8Array): InputToken[] {
    const buf = this.#carry.length > 0 ? concatBytes([this.#carry, bytes]) : bytes;
    const tokens: InputToken[] = [];
    let offset = 0;
    while (offset < buf.length) {
      const result = decodeLegacyKey(buf.subarray(offset));
      if (result === null) break; // incomplete sequence: keep the rest as carry
      tokens.push(result.token);
      offset += result.consumed;
    }
    this.#carry = offset < buf.length ? buf.slice(offset) : new Uint8Array(0);
    return tokens;
  }

  hasPending(): boolean {
    return this.#carry.length > 0;
  }

  // Resolve whatever is buffered when input goes idle: a lone ESC is the Escape
  // key; anything else (a truncated escape / partial UTF-8) is forwarded raw so
  // the child still receives the exact bytes.
  flush(): InputToken[] {
    if (this.#carry.length === 0) return [];
    const carry = this.#carry;
    this.#carry = new Uint8Array(0);
    if (carry.length === 1 && carry[0] === 0x1b) {
      return [
        {
          kind: "key",
          key: { name: "escape", mods: { ctrl: false, alt: false, shift: false } },
          event: "press",
          raw: carry,
        },
      ];
    }
    return [{ kind: "raw", raw: carry }];
  }
}
