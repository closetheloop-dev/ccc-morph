import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import type { TranscriptMessage } from "../src/output-capture";
import { OutputViewer } from "../src/output-viewer";

const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);

afterEach(() => {
  stdout.mockClear();
});

afterAll(() => {
  stdout.mockRestore();
});

function lastFrame(): string {
  const calls = stdout.mock.calls;
  const last = calls[calls.length - 1];
  return last ? String(last[0]) : "";
}

// Two agent responses, already newest-first (as session.ts hands them over).
function twoResponses(): TranscriptMessage[] {
  return [
    { role: "agent", text: "newest" },
    { role: "agent", text: "older" },
  ];
}

describe("output viewer", () => {
  test("down then Enter captures the older response", async () => {
    const result: { captured: string | null; closed: boolean } = { captured: null, closed: false };
    const viewer = new OutputViewer({
      select: (text) => {
        result.captured = text;
      },
      close: () => {
        result.closed = true;
      },
    });

    viewer.open(twoResponses());
    viewer.handleInput(Uint8Array.of(0x1b, 0x5b, 0x42)); // Down arrow -> "older".
    viewer.handleInput(Uint8Array.of(0x0d)); // Enter -> capture.
    await Bun.sleep(5);

    expect(result.captured).toBe("older");
    expect(viewer.active).toBe(false);
  });

  test("Enter on the default selection captures the newest response", async () => {
    const result: { captured: string | null } = { captured: null };
    const viewer = new OutputViewer({
      select: (text) => {
        result.captured = text;
      },
      close: () => {},
    });

    viewer.open(twoResponses());
    viewer.handleInput(Uint8Array.of(0x0d)); // Enter immediately.
    await Bun.sleep(5);

    expect(result.captured).toBe("newest");
  });

  test("q returns to the hub without capturing", () => {
    const result: { captured: string | null; closed: boolean } = { captured: null, closed: false };
    const viewer = new OutputViewer({
      select: (text) => {
        result.captured = text;
      },
      close: () => {
        result.closed = true;
      },
    });

    viewer.open(twoResponses());
    viewer.handleInput(Uint8Array.of(0x71)); // q.

    expect(result.closed).toBe(true);
    expect(result.captured).toBeNull();
    expect(viewer.active).toBe(false);
  });

  test("Escape returns to the hub", async () => {
    const result = { closed: false };
    const viewer = new OutputViewer({
      select: () => {},
      close: () => {
        result.closed = true;
      },
    });

    viewer.open(twoResponses());
    viewer.handleInput(Uint8Array.of(0x1b)); // Lone Escape (resolved after the disambiguation wait).
    await Bun.sleep(45);

    expect(result.closed).toBe(true);
    expect(viewer.active).toBe(false);
  });

  test("empty state: navigation and Enter are inert, only q/Esc leave", () => {
    const result: { captured: string | null; closed: boolean } = { captured: null, closed: false };
    const viewer = new OutputViewer({
      select: (text) => {
        result.captured = text;
      },
      close: () => {
        result.closed = true;
      },
    });

    viewer.open([]);
    viewer.handleInput(Uint8Array.of(0x0d)); // Enter -> nothing to capture.
    viewer.handleInput(Uint8Array.of(0x1b, 0x5b, 0x42)); // Down -> nothing to move.
    expect(result.captured).toBeNull();
    expect(viewer.active).toBe(true);
    expect(lastFrame()).toContain("no history");

    viewer.handleInput(Uint8Array.of(0x71)); // q.
    expect(result.closed).toBe(true);
    expect(viewer.active).toBe(false);
  });

  test("preview scroll clamps at both ends of a long response", () => {
    const long = Array.from({ length: 200 }, (_, i) => `L${i + 1}`).join("\n");
    const viewer = new OutputViewer({ select: () => {}, close: () => {} });

    viewer.open([{ role: "agent", text: long }]);
    viewer.handleInput(Uint8Array.of(0x47)); // G -> bottom.
    for (let i = 0; i < 5; i += 1) viewer.handleInput(Uint8Array.of(0x6a)); // j past the end.
    expect(lastFrame()).toContain("L200");

    viewer.handleInput(Uint8Array.of(0x67)); // g -> top.
    expect(lastFrame()).toContain("L1");
  });

  test("a plan item shows a 'plan:' prefix in the list but captures its raw body", async () => {
    const planBody = "# Big Plan\n\ndo the thing";
    const result: { captured: string | null } = { captured: null };
    const viewer = new OutputViewer({
      select: (text) => {
        result.captured = text;
      },
      close: () => {},
    });

    viewer.open([
      { role: "agent", text: planBody, kind: "plan" },
      { role: "agent", text: "a plain response" },
    ]);
    // The list labels the plan (heading marker stripped), not the raw "#".
    expect(lastFrame()).toContain("plan: Big Plan");

    viewer.handleInput(Uint8Array.of(0x0d)); // Enter on the plan -> capture raw body.
    await Bun.sleep(5);
    expect(result.captured).toBe(planBody);
  });

  test("a keystroke is dropped while a selection is in flight", async () => {
    const state: { calls: number; release: (() => void) | null } = { calls: 0, release: null };
    const viewer = new OutputViewer({
      select: () => {
        state.calls += 1;
        return new Promise<void>((resolve) => {
          state.release = resolve;
        });
      },
      close: () => {},
    });

    viewer.open(twoResponses());
    viewer.handleInput(Uint8Array.of(0x0d)); // Enter -> select() pending.
    viewer.handleInput(Uint8Array.of(0x0d)); // Dropped while busy.
    await Bun.sleep(5);
    expect(state.calls).toBe(1);
    state.release?.();
  });
});
