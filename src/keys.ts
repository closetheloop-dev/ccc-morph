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
