import { describe, expect, test } from "bun:test";
import { ViewerInput, type ViewerInputToken } from "../src/viewer-input";

function collector(): { tokens: ViewerInputToken[]; input: ViewerInput } {
  const tokens: ViewerInputToken[] = [];
  return { tokens, input: new ViewerInput((token) => tokens.push(token)) };
}

const bytes = (...values: number[]) => Uint8Array.of(...values);

describe("viewer input", () => {
  test("emits plain bytes as numeric tokens in order", () => {
    const { tokens, input } = collector();
    input.feed(bytes(0x6a, 0x6b, 0x20)); // j k space
    expect(tokens).toEqual([0x6a, 0x6b, 0x20]);
  });

  test("decodes CSI (ESC [) arrow sequences", () => {
    const { tokens, input } = collector();
    input.feed(bytes(0x1b, 0x5b, 0x41)); // ESC [ A
    input.feed(bytes(0x1b, 0x5b, 0x42)); // ESC [ B
    expect(tokens).toEqual(["up", "down"]);
  });

  test("decodes SS3 (ESC O) arrow sequences", () => {
    const { tokens, input } = collector();
    input.feed(bytes(0x1b, 0x4f, 0x41)); // ESC O A
    input.feed(bytes(0x1b, 0x4f, 0x42)); // ESC O B
    expect(tokens).toEqual(["up", "down"]);
  });

  test("decodes Page Up and Page Down sequences", () => {
    const { tokens, input } = collector();
    input.feed(bytes(0x1b, 0x5b, 0x35, 0x7e, 0x1b, 0x5b, 0x36, 0x7e)); // ESC[5~ ESC[6~
    expect(tokens).toEqual(["page-up", "page-down"]);
  });

  test("reassembles a Page Up sequence split across feeds", () => {
    const { tokens, input } = collector();
    input.feed(bytes(0x1b));
    input.feed(bytes(0x5b));
    input.feed(bytes(0x35));
    input.feed(bytes(0x7e));
    expect(tokens).toEqual(["page-up"]);
  });

  test("reassembles an arrow sequence split across feeds", () => {
    const { tokens, input } = collector();
    input.feed(bytes(0x1b));
    input.feed(bytes(0x5b));
    expect(tokens).toEqual([]); // still incomplete
    input.feed(bytes(0x42));
    expect(tokens).toEqual(["down"]);
  });

  test("a lone Escape is emitted after the escape-sequence timeout", async () => {
    const { tokens, input } = collector();
    input.feed(bytes(0x1b));
    expect(tokens).toEqual([]); // buffered, waiting to disambiguate
    await Bun.sleep(60); // > ESCAPE_SEQUENCE_WAIT_MS (30ms)
    expect(tokens).toEqual([0x1b]);
  });

  test("Escape followed by a non-introducer byte emits ESC then the byte", () => {
    const { tokens, input } = collector();
    input.feed(bytes(0x1b, 0x78)); // ESC x
    expect(tokens).toEqual([0x1b, 0x78]);
  });

  test("an unsupported CSI final byte preserves Escape semantics", () => {
    const { tokens, input } = collector();
    input.feed(bytes(0x1b, 0x5b, 0x43)); // ESC [ C (right arrow — unsupported here)
    expect(tokens).toEqual([0x1b, 0x5b, 0x43]);
  });

  test("reset clears pending bytes and cancels the pending timer", async () => {
    const { tokens, input } = collector();
    input.feed(bytes(0x1b)); // buffered ESC awaiting the timeout
    input.reset();
    await Bun.sleep(60);
    expect(tokens).toEqual([]); // no late emit
  });
});
