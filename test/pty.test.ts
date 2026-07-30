import { expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NoteStore } from "../src/note-store";

test("Bun PTY presents dimensions and TTY streams to the child", async () => {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun executable not found");

  const chunks: Uint8Array[] = [];
  const child = Bun.spawn(
    [
      bun,
      "-e",
      "console.log(JSON.stringify({stdin:process.stdin.isTTY,stdout:process.stdout.isTTY,cols:process.stdout.columns,rows:process.stdout.rows}))",
    ],
    {
      terminal: {
        cols: 91,
        rows: 33,
        data(_terminal, bytes) {
          chunks.push(bytes.slice());
        },
      },
    },
  );

  expect(await child.exited).toBe(0);
  await Bun.sleep(10);
  child.terminal!.close();

  const output = new TextDecoder().decode(Buffer.concat(chunks));
  const json = output.match(/\{[^\r\n]+\}/)?.[0];
  expect(json).toBeDefined();
  expect(JSON.parse(json!)).toEqual({ stdin: true, stdout: true, cols: 91, rows: 33 });
});

test("the wrapper transparently launches a TTY child end to end", async () => {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun executable not found");

  const chunks: Uint8Array[] = [];
  const child = Bun.spawn(
    [
      bun,
      "run",
      resolve(import.meta.dir, "../src/cli.ts"),
      "--no-config",
      "--",
      bun,
      "-e",
      "console.log(JSON.stringify({stdin:process.stdin.isTTY,stdout:process.stdout.isTTY,cols:process.stdout.columns,rows:process.stdout.rows}))",
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      terminal: {
        cols: 77,
        rows: 29,
        data(_terminal, bytes) {
          chunks.push(bytes.slice());
        },
      },
    },
  );

  expect(await child.exited).toBe(0);
  await Bun.sleep(10);
  child.terminal!.close();

  const output = new TextDecoder().decode(Buffer.concat(chunks));
  const json = output.match(/\{[^\r\n]+\}/)?.[0];
  expect(output).not.toContain("\r\r\n");
  expect(json).toBeDefined();
  expect(JSON.parse(json!)).toEqual({ stdin: true, stdout: true, cols: 77, rows: 29 });
});

test("the key inspector reports exact bytes and exits", async () => {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun executable not found");

  const chunks: Uint8Array[] = [];
  const child = Bun.spawn(
    [bun, "run", resolve(import.meta.dir, "../src/cli.ts"), "--inspect-key"],
    {
      cwd: resolve(import.meta.dir, ".."),
      terminal: {
        cols: 80,
        rows: 24,
        data(_terminal, bytes) {
          chunks.push(bytes.slice());
        },
      },
    },
  );

  const output = (): string => new TextDecoder().decode(Buffer.concat(chunks));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (output().includes("Press one key")) break;
    await Bun.sleep(10);
  }
  expect(output()).toContain("Press one key");
  child.terminal!.write(Uint8Array.of(0x1b, 0x5b, 0x5a));
  expect(await child.exited).toBe(0);
  await Bun.sleep(10);
  child.terminal!.close();
  expect(output()).toContain("hex:1b5b5a");
});
test("configured Ctrl-D Ctrl-D reaches the child as one Ctrl-D", async () => {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun executable not found");

  const directory = mkdtempSync(join(tmpdir(), "ccc-morph-test-"));
  const config = join(directory, "config.toml");
  await Bun.write(
    config,
    `version = 1
sequence_timeout_ms = 50
[[bindings]]
keys = ["ctrl-d", "ctrl-d"]
action = { type = "send", keys = ["ctrl-d"] }
`,
  );

  try {
    const chunks: Uint8Array[] = [];
    const child = Bun.spawn(
      [
        bun,
        "run",
        resolve(import.meta.dir, "../src/cli.ts"),
        "--config",
        config,
        "--",
        bun,
        "-e",
        "process.stdin.setRawMode(true); console.log('READY'); process.stdin.once('data', data => { console.log(Buffer.from(data).toString('hex')); process.exit(0) })",
      ],
      {
        cwd: resolve(import.meta.dir, ".."),
        terminal: {
          cols: 80,
          rows: 24,
          data(_terminal, bytes) {
            chunks.push(bytes.slice());
          },
        },
      },
    );

    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (new TextDecoder().decode(Buffer.concat(chunks)).includes("READY")) break;
      await Bun.sleep(10);
    }
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toContain("READY");
    child.terminal!.write(Uint8Array.of(4, 4));
    expect(await child.exited).toBe(0);
    await Bun.sleep(10);
    child.terminal!.close();

    const output = new TextDecoder().decode(Buffer.concat(chunks));
    expect(output).toContain("04");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("discovered Codex app config ignores one Ctrl-D and sends a double press", async () => {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun executable not found");

  const directory = mkdtempSync(join(tmpdir(), "ccc-morph-codex-app-test-"));
  const xdgRoot = join(directory, "xdg");
  const appsDirectory = join(xdgRoot, "ccc-morph", "apps");
  const program = join(directory, "codex");
  mkdirSync(appsDirectory, { recursive: true });
  copyFileSync(resolve(import.meta.dir, "../apps/codex.toml"), join(appsDirectory, "codex.toml"));
  symlinkSync(bun, program);

  const chunks: Uint8Array[] = [];
  const child = Bun.spawn(
    [
      bun,
      "run",
      resolve(import.meta.dir, "../src/cli.ts"),
      "--app",
      "codex",
      "--",
      program,
      "-e",
      "process.stdin.setRawMode(true); console.log('READY'); let seen = 0; process.stdin.on('data', data => { console.log('DATA:' + Buffer.from(data).toString('hex')); if (++seen === 2) process.exit(0) })",
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, XDG_CONFIG_HOME: xdgRoot },
      terminal: {
        cols: 80,
        rows: 24,
        data(_terminal, bytes) {
          chunks.push(bytes.slice());
        },
      },
    },
  );

  const output = (): string => new TextDecoder().decode(Buffer.concat(chunks));
  const waitFor = async (needle: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (output().includes(needle)) return;
      await Bun.sleep(10);
    }
    throw new Error(
      `timed out waiting for ${JSON.stringify(needle)}; output was ${JSON.stringify(output())}`,
    );
  };

  try {
    await waitFor("READY");
    child.terminal!.write(Uint8Array.of(4));
    await Bun.sleep(600);
    expect(output()).not.toContain("DATA:04");

    child.terminal!.write("x");
    await waitFor("DATA:78");
    child.terminal!.write(Uint8Array.of(4, 4));
    await waitFor("DATA:04");
    expect(await child.exited).toBe(0);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    child.terminal?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("adds a note with EDITOR and inserts selected text as bracketed paste", async () => {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun executable not found");

  const directory = mkdtempSync(join(tmpdir(), "ccc-morph-notes-pty-test-"));
  const workspace = join(directory, "workspace");
  const xdgRoot = join(directory, "xdg");
  const config = join(directory, "config.toml");
  const editor = join(directory, "editor");
  mkdirSync(workspace);
  writeFileSync(
    config,
    `version = 1
sequence_timeout_ms = 30
notes_child_mode = "continue"
[[bindings]]
keys = ["ctrl-n"]
action = { type = "add-note" }
[[bindings]]
keys = ["ctrl-p"]
action = { type = "show-notes" }
`,
  );
  writeFileSync(
    editor,
    `#!/usr/bin/env bun
await Bun.write(Bun.argv.at(-1), "first line\\nsecond line\\n");
await Bun.sleep(150);
`,
  );
  chmodSync(editor, 0o755);

  const chunks: Uint8Array[] = [];
  const child = Bun.spawn(
    [
      bun,
      "run",
      resolve(import.meta.dir, "../src/cli.ts"),
      "--config",
      config,
      "--",
      bun,
      "-e",
      "process.stdin.setRawMode(true); let count = 0; setInterval(() => count++, 20); console.log('READY'); process.stdin.once('data', data => { console.log('DATA:' + Buffer.from(data).toString('hex') + ' COUNT:' + count); process.exit(0) })",
    ],
    {
      cwd: workspace,
      env: { ...process.env, XDG_CONFIG_HOME: xdgRoot, VISUAL: "", EDITOR: editor },
      terminal: {
        cols: 80,
        rows: 24,
        data(_terminal, bytes) {
          chunks.push(bytes.slice());
        },
      },
    },
  );

  const output = (): string => new TextDecoder().decode(Buffer.concat(chunks));
  const waitFor = async (needle: string): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (output().includes(needle)) return;
      await Bun.sleep(10);
    }
    throw new Error(
      `timed out waiting for ${JSON.stringify(needle)}; output was ${JSON.stringify(output())}`,
    );
  };

  try {
    await waitFor("READY");
    child.terminal!.write(Uint8Array.of(14)); // Ctrl-N: add note.
    await waitFor("[ccc-morph] note saved");

    child.terminal!.write(Uint8Array.of(16)); // Ctrl-P: open notes.
    await waitFor("ccc-morph notes [active]");
    child.terminal!.write(" \r"); // Select the note and insert it.

    expect(await child.exited).toBe(0);
    await Bun.sleep(20);
    const expected = Buffer.from("\x1b[200~first line\nsecond line\x1b[201~").toString("hex");
    expect(output()).toContain(`DATA:${expected}`);
    const count = Number(output().match(/COUNT:(\d+)/)?.[1] ?? "0");
    expect(count).toBeGreaterThanOrEqual(5);

    const store = new NoteStore(workspace, join(xdgRoot, "ccc-morph", "notes"));
    const notes = store.load();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe("first line\nsecond line");
    expect(notes[0]!.archivedAt).not.toBeNull();
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    child.terminal?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("add-note discards the note when the editor quits without saving", async () => {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun executable not found");

  const directory = mkdtempSync(join(tmpdir(), "ccc-morph-note-discard-test-"));
  const workspace = join(directory, "workspace");
  const xdgRoot = join(directory, "xdg");
  const config = join(directory, "config.toml");
  const editor = join(directory, "editor");
  mkdirSync(workspace);
  writeFileSync(
    config,
    `version = 1
sequence_timeout_ms = 30
notes_child_mode = "continue"
[[bindings]]
keys = ["ctrl-n"]
action = { type = "add-note" }
`,
  );
  // An editor that exits 0 without writing the file, like vim's :q!.
  writeFileSync(editor, `#!/usr/bin/env bun\nawait Bun.sleep(50);\n`);
  chmodSync(editor, 0o755);

  const chunks: Uint8Array[] = [];
  const child = Bun.spawn(
    [
      bun,
      "run",
      resolve(import.meta.dir, "../src/cli.ts"),
      "--config",
      config,
      "--",
      bun,
      "-e",
      "process.stdin.setRawMode(true); console.log('READY'); setInterval(() => {}, 1000)",
    ],
    {
      cwd: workspace,
      env: { ...process.env, XDG_CONFIG_HOME: xdgRoot, VISUAL: "", EDITOR: editor },
      terminal: {
        cols: 80,
        rows: 24,
        data(_terminal, bytes) {
          chunks.push(bytes.slice());
        },
      },
    },
  );

  const output = (): string => new TextDecoder().decode(Buffer.concat(chunks));
  const waitFor = async (needle: string): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (output().includes(needle)) return;
      await Bun.sleep(10);
    }
    throw new Error(
      `timed out waiting for ${JSON.stringify(needle)}; output was ${JSON.stringify(output())}`,
    );
  };

  try {
    await waitFor("READY");
    child.terminal!.write(Uint8Array.of(14)); // Ctrl-N: open the note editor.
    await waitFor("[ccc-morph] note discarded");

    const store = new NoteStore(workspace, join(xdgRoot, "ccc-morph", "notes"));
    expect(store.load()).toEqual([]); // nothing was saved
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    child.terminal?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("e edits an existing note and saves the change in place", async () => {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun executable not found");

  const directory = mkdtempSync(join(tmpdir(), "ccc-morph-note-edit-test-"));
  const workspace = join(directory, "workspace");
  const xdgRoot = join(directory, "xdg");
  const config = join(directory, "config.toml");
  const editor = join(directory, "editor");
  mkdirSync(workspace);
  writeFileSync(
    config,
    `version = 1
sequence_timeout_ms = 30
notes_child_mode = "continue"
[[bindings]]
keys = ["ctrl-p"]
action = { type = "show-notes" }
`,
  );
  // An editor that replaces the note body and saves.
  writeFileSync(
    editor,
    `#!/usr/bin/env bun\nawait Bun.write(Bun.argv.at(-1), "edited by the test\\n");\nawait Bun.sleep(50);\n`,
  );
  chmodSync(editor, 0o755);

  // Seed a note the picker will list.
  const store = new NoteStore(workspace, join(xdgRoot, "ccc-morph", "notes"));
  const seeded = await store.add("before edit");

  const chunks: Uint8Array[] = [];
  const child = Bun.spawn(
    [
      bun,
      "run",
      resolve(import.meta.dir, "../src/cli.ts"),
      "--config",
      config,
      "--",
      bun,
      "-e",
      "process.stdin.setRawMode(true); console.log('READY'); setInterval(() => {}, 1000)",
    ],
    {
      cwd: workspace,
      env: { ...process.env, XDG_CONFIG_HOME: xdgRoot, VISUAL: "", EDITOR: editor },
      terminal: {
        cols: 80,
        rows: 24,
        data(_terminal, bytes) {
          chunks.push(bytes.slice());
        },
      },
    },
  );

  const output = (): string => new TextDecoder().decode(Buffer.concat(chunks));
  const waitFor = async (needle: string): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (output().includes(needle)) return;
      await Bun.sleep(10);
    }
    throw new Error(
      `timed out waiting for ${JSON.stringify(needle)}; output was ${JSON.stringify(output())}`,
    );
  };

  try {
    await waitFor("READY");
    child.terminal!.write(Uint8Array.of(16)); // Ctrl-P: open the picker.
    await waitFor("ccc-morph notes");
    child.terminal!.write(Uint8Array.of(0x65)); // e: edit the current note.
    await waitFor("note updated"); // footer confirms the in-place update

    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (store.load()[0]?.text === "edited by the test") break;
      await Bun.sleep(10);
    }
    const notes = store.load();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.id).toBe(seeded.id); // same note, updated in place
    expect(notes[0]!.text).toBe("edited by the test");
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    child.terminal?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("escapes a bracketed-paste end marker embedded in a note on insert", async () => {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun executable not found");

  const directory = mkdtempSync(join(tmpdir(), "ccc-morph-notes-escape-test-"));
  const workspace = join(directory, "workspace");
  const xdgRoot = join(directory, "xdg");
  const config = join(directory, "config.toml");
  const editor = join(directory, "editor");
  mkdirSync(workspace);
  writeFileSync(
    config,
    `version = 1
sequence_timeout_ms = 30
notes_child_mode = "continue"
[[bindings]]
keys = ["ctrl-n"]
action = { type = "add-note" }
[[bindings]]
keys = ["ctrl-p"]
action = { type = "show-notes" }
`,
  );
  // The note text embeds a real bracketed-paste END marker (ESC [ 201~).
  writeFileSync(
    editor,
    `#!/usr/bin/env bun
await Bun.write(Bun.argv.at(-1), "evil\\x1b[201~end\\n");
await Bun.sleep(150);
`,
  );
  chmodSync(editor, 0o755);

  const chunks: Uint8Array[] = [];
  const child = Bun.spawn(
    [
      bun,
      "run",
      resolve(import.meta.dir, "../src/cli.ts"),
      "--config",
      config,
      "--",
      bun,
      "-e",
      "process.stdin.setRawMode(true); console.log('READY'); process.stdin.once('data', data => { console.log('DATA:' + Buffer.from(data).toString('hex')); process.exit(0) })",
    ],
    {
      cwd: workspace,
      env: { ...process.env, XDG_CONFIG_HOME: xdgRoot, VISUAL: "", EDITOR: editor },
      terminal: {
        cols: 80,
        rows: 24,
        data(_terminal, bytes) {
          chunks.push(bytes.slice());
        },
      },
    },
  );

  const output = (): string => new TextDecoder().decode(Buffer.concat(chunks));
  const waitFor = async (needle: string): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (output().includes(needle)) return;
      await Bun.sleep(10);
    }
    throw new Error(
      `timed out waiting for ${JSON.stringify(needle)}; output was ${JSON.stringify(output())}`,
    );
  };

  try {
    await waitFor("READY");
    child.terminal!.write(Uint8Array.of(14)); // Ctrl-N: add the note.
    await waitFor("[ccc-morph] note saved");
    child.terminal!.write(Uint8Array.of(16)); // Ctrl-P: open the picker.
    await waitFor("ccc-morph notes [active]");
    child.terminal!.write(" \r"); // Select + insert.

    expect(await child.exited).toBe(0);
    await Bun.sleep(20);
    // The note's inner ESC[201~ is neutralized to the literal text \x1b[201~, so
    // only the wrapper's real ESC[201~ can terminate the bracketed paste.
    const expected = Buffer.from("\x1b[200~evil\\x1b[201~end\x1b[201~").toString("hex");
    expect(output()).toContain(`DATA:${expected}`);

    // The stored note keeps the raw marker; only the insert escapes it.
    const store = new NoteStore(workspace, join(xdgRoot, "ccc-morph", "notes"));
    expect(store.load()[0]!.text).toBe("evil\x1b[201~end");
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    child.terminal?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pause mode recovers after an empty note and an editor failure", async () => {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun executable not found");

  const directory = mkdtempSync(join(tmpdir(), "ccc-morph-notes-pause-test-"));
  const workspace = join(directory, "workspace");
  const xdgRoot = join(directory, "xdg");
  const config = join(directory, "config.toml");
  const editor = join(directory, "editor");
  const editorState = join(directory, "editor-state");
  mkdirSync(workspace);
  writeFileSync(
    config,
    `version = 1
sequence_timeout_ms = 30
notes_child_mode = "pause"
[[bindings]]
keys = ["ctrl-n"]
action = { type = "add-note" }
`,
  );
  writeFileSync(
    editor,
    `#!/usr/bin/env bun
const state = ${JSON.stringify(editorState)};
if (await Bun.file(state).exists()) process.exit(7);
await Bun.write(state, "used");
await Bun.write(Bun.argv.at(-1), ""); // save an empty buffer -> empty note discarded
await Bun.sleep(150);
`,
  );
  chmodSync(editor, 0o755);

  const chunks: Uint8Array[] = [];
  const child = Bun.spawn(
    [
      bun,
      "run",
      resolve(import.meta.dir, "../src/cli.ts"),
      "--config",
      config,
      "--",
      bun,
      "-e",
      "process.stdin.setRawMode(true); let count = 0; setInterval(() => count++, 20); console.log('READY'); process.stdin.once('data', () => { console.log('COUNT:' + count); process.exit(0) })",
    ],
    {
      cwd: workspace,
      env: { ...process.env, XDG_CONFIG_HOME: xdgRoot, VISUAL: "", EDITOR: editor },
      terminal: {
        cols: 80,
        rows: 24,
        data(_terminal, bytes) {
          chunks.push(bytes.slice());
        },
      },
    },
  );

  const output = (): string => new TextDecoder().decode(Buffer.concat(chunks));
  const waitFor = async (needle: string): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (output().includes(needle)) return;
      await Bun.sleep(10);
    }
    throw new Error(
      `timed out waiting for ${JSON.stringify(needle)}; output was ${JSON.stringify(output())}`,
    );
  };

  try {
    await waitFor("READY");
    child.terminal!.write(Uint8Array.of(14));
    await waitFor("[ccc-morph] empty note discarded");

    child.terminal!.write(Uint8Array.of(14));
    await waitFor("[ccc-morph] editor exited with status 7");

    child.terminal!.write("x");
    expect(await child.exited).toBe(0);
    const count = Number(output().match(/COUNT:(\d+)/)?.[1] ?? "999");
    expect(count).toBeLessThan(5);
    expect(new NoteStore(workspace, join(xdgRoot, "ccc-morph", "notes")).load()).toEqual([]);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    child.terminal?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("returning from the error viewer forces the child through a real resize", async () => {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun executable not found");

  const directory = mkdtempSync(join(tmpdir(), "ccc-morph-viewer-test-"));
  const config = join(directory, "config.toml");
  await Bun.write(
    config,
    `version = 1
sequence_timeout_ms = 30
[[bindings]]
keys = ["ctrl-f"]
action = { type = "run", argv = [${JSON.stringify(bun)}, "-e", "process.exit(9)"] }
[[bindings]]
keys = ["ctrl-e"]
action = { type = "show-errors" }
[[bindings]]
keys = ["ctrl-x"]
action = { type = "quit" }
`,
  );

  const chunks: Uint8Array[] = [];
  const child = Bun.spawn(
    [
      bun,
      "run",
      resolve(import.meta.dir, "../src/cli.ts"),
      "--config",
      config,
      "--",
      bun,
      "-e",
      "process.stdin.setRawMode(true); const size = () => Bun.spawnSync(['stty', 'size'], { stdin: 0 }).stdout.toString().trim(); console.log('READY'); process.on('SIGWINCH', () => console.log('DRAW:' + size())); setInterval(() => {}, 1000)",
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      terminal: {
        cols: 80,
        rows: 24,
        data(_terminal, bytes) {
          chunks.push(bytes.slice());
        },
      },
    },
  );

  const output = (): string => new TextDecoder().decode(Buffer.concat(chunks));
  const waitFor = async (needle: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (output().includes(needle)) return;
      await Bun.sleep(10);
    }
    throw new Error(
      `timed out waiting for ${JSON.stringify(needle)}; output was ${JSON.stringify(output())}`,
    );
  };

  try {
    await waitFor("READY");
    child.terminal!.write(Uint8Array.of(6)); // Ctrl-F: fail a background action.
    await waitFor("[ccc-morph] ctrl-f failed");
    child.terminal!.write(Uint8Array.of(5)); // Ctrl-E: show retained error.
    await waitFor("ccc-morph action error");

    const returnOffset = output().length;
    child.terminal!.write("q");
    await Bun.sleep(100);
    const afterReturn = output().slice(returnOffset);

    expect(afterReturn).toContain("DRAW:23 80");
    expect(afterReturn).toContain("DRAW:24 80");

    child.terminal!.write(Uint8Array.of(24)); // Ctrl-X: quit wrapper.
    expect(await child.exited).toBe(143);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    child.terminal?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restores the full size only after a slow child reacts to the shrunken PTY", async () => {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun executable not found");

  const directory = mkdtempSync(join(tmpdir(), "ccc-morph-slow-viewer-test-"));
  const config = join(directory, "config.toml");
  await Bun.write(
    config,
    `version = 1
sequence_timeout_ms = 30
[[bindings]]
keys = ["ctrl-f"]
action = { type = "run", argv = [${JSON.stringify(bun)}, "-e", "process.exit(9)"] }
[[bindings]]
keys = ["ctrl-e"]
action = { type = "show-errors" }
[[bindings]]
keys = ["ctrl-x"]
action = { type = "quit" }
`,
  );

  const chunks: Uint8Array[] = [];
  const child = Bun.spawn(
    [
      bun,
      "run",
      resolve(import.meta.dir, "../src/cli.ts"),
      "--config",
      config,
      "--",
      bun,
      "-e",
      // A deliberately slow TUI stand-in: it takes 150 ms to react to SIGWINCH
      // before reading the PTY size, like a heavyweight renderer waking from
      // SIGSTOP. The wrapper must keep the shrunken size until it reacts.
      "process.stdin.setRawMode(true); const size = () => Bun.spawnSync(['stty', 'size'], { stdin: 0 }).stdout.toString().trim(); console.log('READY'); process.on('SIGWINCH', () => { Bun.sleepSync(150); console.log('DRAW:' + size()); }); setInterval(() => {}, 1000)",
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      terminal: {
        cols: 80,
        rows: 24,
        data(_terminal, bytes) {
          chunks.push(bytes.slice());
        },
      },
    },
  );

  const output = (): string => new TextDecoder().decode(Buffer.concat(chunks));
  const waitFor = async (needle: string): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (output().includes(needle)) return;
      await Bun.sleep(10);
    }
    throw new Error(
      `timed out waiting for ${JSON.stringify(needle)}; output was ${JSON.stringify(output())}`,
    );
  };

  try {
    await waitFor("READY");
    child.terminal!.write(Uint8Array.of(6)); // Ctrl-F: fail a background action.
    await waitFor("[ccc-morph] ctrl-f failed");
    child.terminal!.write(Uint8Array.of(5)); // Ctrl-E: show retained error.
    await waitFor("ccc-morph action error");

    const returnOffset = output().length;
    child.terminal!.write("q");
    await waitFor("DRAW:23 80");
    await waitFor("DRAW:24 80");
    const afterReturn = output().slice(returnOffset);
    expect(afterReturn).toContain("DRAW:23 80");
    expect(afterReturn).toContain("DRAW:24 80");

    child.terminal!.write(Uint8Array.of(24)); // Ctrl-X: quit wrapper.
    expect(await child.exited).toBe(143);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    child.terminal?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports a still-running action instead of starting a duplicate", async () => {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun executable not found");

  const directory = mkdtempSync(join(tmpdir(), "ccc-morph-dedup-test-"));
  const config = join(directory, "config.toml");
  await Bun.write(
    config,
    `version = 1
sequence_timeout_ms = 30
notice_timeout_ms = 200
[[bindings]]
keys = ["ctrl-f"]
action = { type = "run", argv = [${JSON.stringify(bun)}, "-e", "await Bun.sleep(800)"] }
[[bindings]]
keys = ["ctrl-x"]
action = { type = "quit" }
`,
  );

  const chunks: Uint8Array[] = [];
  const child = Bun.spawn(
    [
      bun,
      "run",
      resolve(import.meta.dir, "../src/cli.ts"),
      "--config",
      config,
      "--",
      bun,
      "-e",
      "process.stdin.setRawMode(true); const size = () => Bun.spawnSync(['stty', 'size'], { stdin: 0 }).stdout.toString().trim(); console.log('READY'); process.on('SIGWINCH', () => console.log('DRAW:' + size())); setInterval(() => {}, 1000)",
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      terminal: {
        cols: 80,
        rows: 24,
        data(_terminal, bytes) {
          chunks.push(bytes.slice());
        },
      },
    },
  );

  const output = (): string => new TextDecoder().decode(Buffer.concat(chunks));
  const waitFor = async (needle: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (output().includes(needle)) return;
      await Bun.sleep(10);
    }
    throw new Error(
      `timed out waiting for ${JSON.stringify(needle)}; output was ${JSON.stringify(output())}`,
    );
  };

  try {
    await waitFor("READY");
    child.terminal!.write(Uint8Array.of(6)); // Ctrl-F: start the slow action.
    await Bun.sleep(100);
    expect(output()).not.toContain("is still running");
    child.terminal!.write(Uint8Array.of(6)); // Ctrl-F again while it runs.
    await waitFor("[ccc-morph] ctrl-f is still running");

    // notice_timeout_ms later, the notice clears itself and the child is
    // nudged through a real resize so it repaints the row's true content.
    await waitFor("DRAW:23 80");
    await waitFor("DRAW:24 80");

    child.terminal!.write(Uint8Array.of(24)); // Ctrl-X: quit wrapper.
    expect(await child.exited).toBe(143);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    child.terminal?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("flashes a completion status when a background action finishes cleanly", async () => {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun executable not found");

  const directory = mkdtempSync(join(tmpdir(), "ccc-morph-done-test-"));
  const config = join(directory, "config.toml");
  await Bun.write(
    config,
    `version = 1
sequence_timeout_ms = 30
completion_notice_timeout_ms = 200
[[bindings]]
keys = ["ctrl-f"]
action = { type = "run", argv = [${JSON.stringify(bun)}, "-e", "await Bun.sleep(50)"] }
[[bindings]]
keys = ["ctrl-x"]
action = { type = "quit" }
`,
  );

  const chunks: Uint8Array[] = [];
  const child = Bun.spawn(
    [
      bun,
      "run",
      resolve(import.meta.dir, "../src/cli.ts"),
      "--config",
      config,
      "--",
      bun,
      "-e",
      "process.stdin.setRawMode(true); const size = () => Bun.spawnSync(['stty', 'size'], { stdin: 0 }).stdout.toString().trim(); console.log('READY'); process.on('SIGWINCH', () => console.log('DRAW:' + size())); setInterval(() => {}, 1000)",
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      terminal: {
        cols: 80,
        rows: 24,
        data(_terminal, bytes) {
          chunks.push(bytes.slice());
        },
      },
    },
  );

  const output = (): string => new TextDecoder().decode(Buffer.concat(chunks));
  const waitFor = async (needle: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (output().includes(needle)) return;
      await Bun.sleep(10);
    }
    throw new Error(
      `timed out waiting for ${JSON.stringify(needle)}; output was ${JSON.stringify(output())}`,
    );
  };

  try {
    await waitFor("READY");
    child.terminal!.write(Uint8Array.of(6)); // Ctrl-F: run the quick action.
    await waitFor("[ccc-morph] ctrl-f done in");

    // completion_notice_timeout_ms later, the status clears itself and the child
    // is nudged through a real resize so it repaints the row's true content.
    await waitFor("DRAW:23 80");
    await waitFor("DRAW:24 80");

    child.terminal!.write(Uint8Array.of(24)); // Ctrl-X: quit wrapper.
    expect(await child.exited).toBe(143);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    child.terminal?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("flashes a start status when a background action begins", async () => {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun executable not found");

  const directory = mkdtempSync(join(tmpdir(), "ccc-morph-start-test-"));
  const config = join(directory, "config.toml");
  await Bun.write(
    config,
    `version = 1
sequence_timeout_ms = 30
start_notice_timeout_ms = 5000
[[bindings]]
keys = ["ctrl-f"]
action = { type = "run", argv = [${JSON.stringify(bun)}, "-e", "await Bun.sleep(200)"] }
[[bindings]]
keys = ["ctrl-x"]
action = { type = "quit" }
`,
  );

  const chunks: Uint8Array[] = [];
  const child = Bun.spawn(
    [
      bun,
      "run",
      resolve(import.meta.dir, "../src/cli.ts"),
      "--config",
      config,
      "--",
      bun,
      "-e",
      "process.stdin.setRawMode(true); console.log('READY'); setInterval(() => {}, 1000)",
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      terminal: {
        cols: 80,
        rows: 24,
        data(_terminal, bytes) {
          chunks.push(bytes.slice());
        },
      },
    },
  );

  const output = (): string => new TextDecoder().decode(Buffer.concat(chunks));
  const waitFor = async (needle: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (output().includes(needle)) return;
      await Bun.sleep(10);
    }
    throw new Error(
      `timed out waiting for ${JSON.stringify(needle)}; output was ${JSON.stringify(output())}`,
    );
  };

  try {
    await waitFor("READY");
    child.terminal!.write(Uint8Array.of(6)); // Ctrl-F: run the slow action.
    // The start status shows immediately, then the completion status replaces it.
    await waitFor("[ccc-morph] ctrl-f started");
    await waitFor("[ccc-morph] ctrl-f done in");

    child.terminal!.write(Uint8Array.of(24)); // Ctrl-X: quit wrapper.
    expect(await child.exited).toBe(143);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    child.terminal?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("re-asserts an unseen failure notice over child output until viewed", async () => {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun executable not found");

  const directory = mkdtempSync(join(tmpdir(), "ccc-morph-failure-notice-test-"));
  const config = join(directory, "config.toml");
  await Bun.write(
    config,
    `version = 1
sequence_timeout_ms = 30
[[bindings]]
keys = ["ctrl-f"]
action = { type = "run", argv = [${JSON.stringify(bun)}, "-e", "process.exit(9)"] }
[[bindings]]
keys = ["ctrl-e"]
action = { type = "show-errors" }
[[bindings]]
keys = ["ctrl-x"]
action = { type = "quit" }
`,
  );

  const chunks: Uint8Array[] = [];
  const child = Bun.spawn(
    [
      bun,
      "run",
      resolve(import.meta.dir, "../src/cli.ts"),
      "--config",
      config,
      "--",
      bun,
      "-e",
      // Continuous output that keeps painting over the bottom row.
      "process.stdin.setRawMode(true); console.log('READY'); setInterval(() => console.log('TICK'), 100)",
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      terminal: {
        cols: 80,
        rows: 24,
        data(_terminal, bytes) {
          chunks.push(bytes.slice());
        },
      },
    },
  );

  const output = (): string => new TextDecoder().decode(Buffer.concat(chunks));
  const waitFor = async (needle: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (output().includes(needle)) return;
      await Bun.sleep(10);
    }
    throw new Error(
      `timed out waiting for ${JSON.stringify(needle)}; output was ${JSON.stringify(output())}`,
    );
  };
  const failures = (text: string): number => text.split("failed:").length - 1;

  try {
    await waitFor("READY");
    child.terminal!.write(Uint8Array.of(6)); // Ctrl-F: fail immediately.
    await waitFor("failed:");

    // The ticking child keeps producing output; the unseen failure notice must
    // be re-asserted after each pause rather than vanishing after one paint.
    for (let attempt = 0; attempt < 100 && failures(output()) < 3; attempt += 1) {
      await Bun.sleep(10);
    }
    expect(failures(output())).toBeGreaterThanOrEqual(3);

    child.terminal!.write(Uint8Array.of(5)); // Ctrl-E: view the error.
    await waitFor("ccc-morph action error");
    child.terminal!.write("q");
    await Bun.sleep(100);

    // Seen now: ticks continue, but the notice must not come back.
    const afterView = output().length;
    await Bun.sleep(500);
    expect(failures(output().slice(afterView))).toBe(0);

    child.terminal!.write(Uint8Array.of(24)); // Ctrl-X: quit wrapper.
    expect(await child.exited).toBe(143);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    child.terminal?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("truncates a long failure reason but keeps the details suffix visible", async () => {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun executable not found");

  const directory = mkdtempSync(join(tmpdir(), "ccc-morph-failure-fit-test-"));
  const config = join(directory, "config.toml");
  await Bun.write(
    config,
    `version = 1
sequence_timeout_ms = 30
[[bindings]]
keys = ["ctrl-f"]
action = { type = "run", argv = [${JSON.stringify(bun)}, "-e", "console.error('X'.repeat(200)); process.exit(9)"] }
[[bindings]]
keys = ["ctrl-e"]
action = { type = "show-errors" }
[[bindings]]
keys = ["ctrl-x"]
action = { type = "quit" }
`,
  );

  const chunks: Uint8Array[] = [];
  const child = Bun.spawn(
    [
      bun,
      "run",
      resolve(import.meta.dir, "../src/cli.ts"),
      "--config",
      config,
      "--",
      bun,
      "-e",
      "process.stdin.setRawMode(true); console.log('READY'); setInterval(() => console.log('TICK'), 100)",
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      // Narrow enough that the long reason must be truncated, wide enough that the
      // fixed head and "— ctrl-e for details" tail still fit.
      terminal: {
        cols: 60,
        rows: 24,
        data(_terminal, bytes) {
          chunks.push(bytes.slice());
        },
      },
    },
  );

  const output = (): string => new TextDecoder().decode(Buffer.concat(chunks));
  const waitFor = async (needle: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (output().includes(needle)) return;
      await Bun.sleep(10);
    }
    throw new Error(
      `timed out waiting for ${JSON.stringify(needle)}; output was ${JSON.stringify(output())}`,
    );
  };

  try {
    await waitFor("READY");
    child.terminal!.write(Uint8Array.of(6)); // Ctrl-F: fail with a long reason.
    await waitFor("ctrl-f failed:");

    // The navigational suffix survives, the reason is ellipsized, and the full
    // 200-char reason never makes it onto the row.
    await waitFor("ctrl-e for details");
    expect(output()).toContain("…");
    expect(output()).not.toContain("X".repeat(60));

    child.terminal!.write(Uint8Array.of(24)); // Ctrl-X: quit wrapper.
    expect(await child.exited).toBe(143);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    child.terminal?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("discovered app configs specialize the same shortcut by executable basename", async () => {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun executable not found");

  const directory = mkdtempSync(join(tmpdir(), "ccc-morph-app-config-test-"));
  const xdgRoot = join(directory, "xdg");
  const appsDirectory = join(xdgRoot, "ccc-morph", "apps");
  mkdirSync(appsDirectory, { recursive: true });
  const programA = join(directory, "program-a");
  const programB = join(directory, "program-b");
  symlinkSync(bun, programA);
  symlinkSync(bun, programB);
  await Bun.write(
    join(appsDirectory, "program-a.toml"),
    `version = 1
inherit_globals = false
[[bindings]]
keys = ["ctrl-g"]
action = { type = "send", bytes = "01" }
`,
  );
  await Bun.write(
    join(appsDirectory, "program-b.toml"),
    `version = 1
inherit_globals = false
[[bindings]]
keys = ["ctrl-g"]
action = { type = "send", bytes = "02" }
`,
  );

  const run = async (program: string): Promise<string> => {
    const chunks: Uint8Array[] = [];
    const child = Bun.spawn(
      [
        bun,
        "run",
        resolve(import.meta.dir, "../src/cli.ts"),
        // `bun run` consumes the first `--`; the second reaches the CLI as its
        // wrapper/command separator. No wrapper flags → pure basename discovery.
        "--",
        "--",
        program,
        "-e",
        "process.stdin.setRawMode(true); console.log('READY'); process.stdin.once('data', data => { console.log(Buffer.from(data).toString('hex')); process.exit(0) })",
      ],
      {
        cwd: resolve(import.meta.dir, ".."),
        env: { ...process.env, XDG_CONFIG_HOME: xdgRoot },
        terminal: {
          cols: 80,
          rows: 24,
          data(_terminal, bytes) {
            chunks.push(bytes.slice());
          },
        },
      },
    );

    const output = (): string => new TextDecoder().decode(Buffer.concat(chunks));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (output().includes("READY")) break;
      await Bun.sleep(10);
    }
    expect(output()).toContain("READY");
    child.terminal!.write(Uint8Array.of(7));
    expect(await child.exited).toBe(0);
    await Bun.sleep(10);
    child.terminal!.close();
    return output();
  };

  try {
    expect(await run(programA)).toContain("01");
    expect(await run(programB)).toContain("02");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("defers to the child transparently when not on a terminal", async () => {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun executable not found");

  // No `terminal:` here, so the wrapper's stdout is a pipe (not a TTY) and it
  // must run the child directly, forwarding output and the exit code.
  const child = Bun.spawn(
    [
      bun,
      "run",
      resolve(import.meta.dir, "../src/cli.ts"),
      "--no-config",
      "--",
      bun,
      "-e",
      "console.log('passthrough-ok'); process.exit(3)",
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const output = await new Response(child.stdout).text();
  const code = await child.exited;
  expect(output).toContain("passthrough-ok");
  expect(code).toBe(3);
});

test("a background command completing while the notes hub is open does not paint over it", async () => {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun executable not found");

  const directory = mkdtempSync(join(tmpdir(), "ccc-morph-notice-modal-test-"));
  const workspace = join(directory, "workspace");
  const config = join(directory, "config.toml");
  mkdirSync(workspace);
  writeFileSync(
    config,
    `version = 1
sequence_timeout_ms = 30
[[bindings]]
keys = ["ctrl-r"]
action = { type = "run", argv = ["sleep", "0.4"] }
[[bindings]]
keys = ["ctrl-p"]
action = { type = "show-notes" }
`,
  );

  const chunks: Uint8Array[] = [];
  const child = Bun.spawn(
    [
      bun,
      "run",
      resolve(import.meta.dir, "../src/cli.ts"),
      "--config",
      config,
      "--",
      bun,
      "-e",
      "console.log('READY'); setInterval(() => {}, 1000);",
    ],
    {
      cwd: workspace,
      env: { ...process.env },
      terminal: {
        cols: 80,
        rows: 24,
        data(_terminal, bytes) {
          chunks.push(bytes.slice());
        },
      },
    },
  );

  const output = (): string => new TextDecoder().decode(Buffer.concat(chunks));
  const waitFor = async (needle: string): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (output().includes(needle)) return;
      await Bun.sleep(10);
    }
    throw new Error(
      `timed out waiting for ${JSON.stringify(needle)}; output was ${JSON.stringify(output())}`,
    );
  };

  try {
    await waitFor("READY");
    child.terminal!.write(Uint8Array.of(0x12)); // Ctrl-R: start the ~0.4s background command
    child.terminal!.write(Uint8Array.of(0x10)); // Ctrl-P: open the notes hub over it
    await waitFor("ccc-morph notes [active]");
    // The command fired (its "started" notice was painted before the hub opened)...
    expect(output()).toContain("started");
    // ...and finishes while the hub owns the screen, so its completion notice must be
    // suppressed by the #modalActive() guard rather than painted over the picker.
    await Bun.sleep(700);
    expect(output()).not.toContain("done in");
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    child.terminal?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
