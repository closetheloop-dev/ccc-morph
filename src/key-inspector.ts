import { bytesKey } from "./keys";

const KEY_IDLE_MS = 40;

function runStty(args: string[]): string {
  const result = Bun.spawnSync(["stty", ...args], {
    stdin: 0,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const detail = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`stty ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function captureKey(): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (timer !== null) clearTimeout(timer);
      process.stdin.off("data", onData);
      resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk.slice());
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(finish, KEY_IDLE_MS);
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

export async function inspectKey(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("--inspect-key requires both stdin and stdout to be terminals");
  }

  const terminalState = runStty(["-g"]);
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    try {
      runStty([terminalState]);
    } catch {
      // Best effort during process shutdown.
    }
  };
  process.on("exit", restore);

  try {
    runStty(["raw", "-echo"]);
    process.stdout.write("Press one key or key combination… ");
    const bytes = await captureKey();
    process.stdout.write(`\r\nhex:${bytesKey(bytes)}\r\n`);
    return 0;
  } finally {
    process.stdin.pause();
    process.off("exit", restore);
    restore();
  }
}
