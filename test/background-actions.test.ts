import { describe, expect, test } from "bun:test";
import { BackgroundActions } from "../src/background-actions";
import type { ActionError } from "../src/types";

const bun = Bun.which("bun");
if (!bun) throw new Error("Bun executable not found");

describe("background actions", () => {
  test("successful commands report start then completion, not failure", async () => {
    const errors: ActionError[] = [];
    const completions: { label: string; durationMs: number }[] = [];
    const starts: string[] = [];
    const actions = new BackgroundActions(
      1024,
      (error) => errors.push(error),
      (label, durationMs) => completions.push({ label, durationMs }),
      (label) => starts.push(label),
    );
    await actions.run("success", "ctrl-g s", [bun, "-e", "console.log('ok')"]);
    expect(errors).toEqual([]);
    expect(starts).toEqual(["ctrl-g s"]);
    expect(completions).toHaveLength(1);
    expect(completions[0]!.label).toBe("ctrl-g s");
    expect(completions[0]!.durationMs).toBeGreaterThanOrEqual(0);
    actions.shutdown();
  });

  test("failed commands retain bounded output", async () => {
    const errors: ActionError[] = [];
    const completions: string[] = [];
    const actions = new BackgroundActions(
      4,
      (error) => errors.push(error),
      (label) => completions.push(label),
      () => {},
    );
    await actions.run("failure", "ctrl-g f", [
      bun,
      "-e",
      "process.stdout.write('12345'); process.stderr.write('bad'); process.exit(7)",
    ]);

    expect(errors).toHaveLength(1);
    expect(errors[0]!.exitCode).toBe(7);
    expect(errors[0]!.stdout).toBe("1234");
    expect(errors[0]!.stdoutTruncated).toBe(true);
    expect(errors[0]!.stderr).toBe("bad");
    expect(errors[0]!.stderrTruncated).toBe(false);
    expect(completions).toEqual([]);
    actions.shutdown();
  });

  test("suppresses concurrent duplicates", async () => {
    const actions = new BackgroundActions(
      1024,
      () => {},
      () => {},
      () => {},
    );
    const first = actions.run("same", "same", [bun, "-e", "await Bun.sleep(20)"]);
    expect(actions.run("same", "same", [bun, "-e", "throw new Error('must not run')"])).toBeNull();
    await first;
    actions.shutdown();
  });
});
