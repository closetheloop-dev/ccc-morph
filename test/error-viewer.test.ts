import { describe, expect, test } from "bun:test";
import { ErrorViewer } from "../src/error-viewer";
import type { ActionError } from "../src/types";

function makeError(overrides: Partial<ActionError>): ActionError {
  return {
    binding: "ctrl-f",
    argv: ["sh", "-lc", "boom"],
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    exitCode: 1,
    signal: null,
    message: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

// Open the viewer with one error and capture what it writes to the terminal.
function renderOf(error: ActionError): string {
  const viewer = new ErrorViewer({ pauseChild: () => {}, resumeChild: () => {} });
  viewer.add(error);
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    viewer.open();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

describe("ErrorViewer rendering", () => {
  test("escapes a bare carriage return so it cannot move the cursor", () => {
    const rendered = renderOf(makeError({ stderr: "progress line\rreplaced" }));
    // The bare \r is shown as the literal escape, not emitted as a control byte.
    expect(rendered).toContain("progress line\\x0dreplaced");
    // The only raw CRs in the output are the viewer's own \r\n line joins; the error content
    // contributes none.
    expect(rendered.replace(/\r\n/g, "\n")).not.toContain("\r");
  });

  test("normalizes CRLF to real line breaks (not an escaped \\x0d)", () => {
    const rendered = renderOf(makeError({ stderr: "first\r\nsecond" }));
    expect(rendered).not.toContain("\\x0d");
    // Both halves survive as separate body lines.
    expect(rendered).toContain("first");
    expect(rendered).toContain("second");
  });

  test("still escapes other control bytes (ESC) in error text", () => {
    const rendered = renderOf(makeError({ stderr: "a\x1b[31mred" }));
    expect(rendered).toContain("a\\x1b[31mred");
  });
});
