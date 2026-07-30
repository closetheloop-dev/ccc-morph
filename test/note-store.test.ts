import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoteStore, workspaceNotesFilename } from "../src/note-store";

function temporaryWorkspace(): { root: string; workspace: string; notes: string } {
  const root = mkdtempSync(join(tmpdir(), "ccc-morph-note-store-test-"));
  const workspace = join(root, "workspace");
  const notes = join(root, "notes");
  mkdirSync(workspace);
  return { root, workspace, notes };
}

describe("workspace note store", () => {
  test("uses a readable flat path plus a collision-safe hash", () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-morph-note-name-test-"));
    const first = join(root, "a-b", "c");
    const second = join(root, "a", "b-c");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    try {
      const firstName = workspaceNotesFilename(first);
      const secondName = workspaceNotesFilename(second);
      expect(firstName).toEndWith(".jsonl");
      expect(firstName).not.toContain("/");
      expect(firstName).not.toBe(secondName);
      expect(firstName).toMatch(/-[0-9a-f]{8}\.jsonl$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("adds, archives, restores, and deletes notes in one JSONL snapshot", async () => {
    const { root, workspace, notes } = temporaryWorkspace();
    const store = new NoteStore(workspace, notes);
    try {
      const first = await store.add("first\nline");
      const second = await store.add("second");
      expect(store.load().map((note) => note.text)).toEqual(["first\nline", "second"]);

      await store.archive([first.id]);
      expect(store.load().find((note) => note.id === first.id)!.archivedAt).not.toBeNull();
      await store.restore(first.id);
      expect(store.load().find((note) => note.id === first.id)!.archivedAt).toBeNull();
      await store.delete(second.id);
      expect(store.load().map((note) => note.id)).toEqual([first.id]);

      const lines = readFileSync(store.path, "utf8").trimEnd().split("\n");
      expect(JSON.parse(lines[0]!)).toMatchObject({
        type: "workspace",
        version: 1,
        path: workspace,
      });
      expect(JSON.parse(lines[1]!)).toMatchObject({ type: "note", id: first.id });
      expect(statSync(notes).mode & 0o777).toBe(0o700);
      expect(statSync(store.path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("updates a note's text while preserving id, createdAt, and archivedAt", async () => {
    const { root, workspace, notes } = temporaryWorkspace();
    const store = new NoteStore(workspace, notes);
    try {
      const note = await store.add("original text");
      await store.archive([note.id]);
      await store.update(note.id, "revised text");
      const reloaded = store.load().find((n) => n.id === note.id)!;
      expect(reloaded.text).toBe("revised text");
      expect(reloaded.createdAt).toBe(note.createdAt);
      expect(reloaded.archivedAt).not.toBeNull();

      // An unknown id is a no-op that leaves every note untouched.
      await store.update("does-not-exist", "ignored");
      expect(store.load().find((n) => n.id === note.id)!.text).toBe("revised text");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("serializes concurrent mutations without dropping notes", async () => {
    const { root, workspace, notes } = temporaryWorkspace();
    const first = new NoteStore(workspace, notes);
    const second = new NoteStore(workspace, notes);
    try {
      await Promise.all([first.add("one"), second.add("two")]);
      expect(
        first
          .load()
          .map((note) => note.text)
          .sort(),
      ).toEqual(["one", "two"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses to overwrite malformed or mismatched workspace files", async () => {
    const { root, workspace, notes } = temporaryWorkspace();
    const store = new NoteStore(workspace, notes);
    mkdirSync(notes);
    try {
      writeFileSync(store.path, "{broken\n");
      await expect(store.add("must not write")).rejects.toThrow("invalid workspace header");
      expect(readFileSync(store.path, "utf8")).toBe("{broken\n");

      writeFileSync(
        store.path,
        `${JSON.stringify({ type: "workspace", version: 1, path: "/somewhere/else" })}\n`,
      );
      await expect(store.add("must not write")).rejects.toThrow("belongs to");
    } finally {
      chmodSync(notes, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads an empty list before any note exists", () => {
    const { root, workspace, notes } = temporaryWorkspace();
    const store = new NoteStore(workspace, notes);
    try {
      expect(store.load()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("archives multiple ids at once and treats unknown ids as no-ops", async () => {
    const { root, workspace, notes } = temporaryWorkspace();
    const store = new NoteStore(workspace, notes);
    try {
      const a = await store.add("a");
      const b = await store.add("b");
      const c = await store.add("c");
      await store.archive([a.id, c.id]);
      const byId = new Map(store.load().map((note) => [note.id, note]));
      expect(byId.get(a.id)!.archivedAt).not.toBeNull();
      expect(byId.get(b.id)!.archivedAt).toBeNull();
      expect(byId.get(c.id)!.archivedAt).not.toBeNull();

      // Unknown ids leave every note untouched.
      await store.archive(["nope"]);
      await store.restore("nope");
      await store.delete("nope");
      expect(
        store
          .load()
          .map((note) => note.id)
          .sort(),
      ).toEqual([a.id, b.id, c.id].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an unsupported header version and a corrupt note line", async () => {
    const { root, workspace, notes } = temporaryWorkspace();
    const store = new NoteStore(workspace, notes);
    try {
      await store.add("valid");
      const lines = readFileSync(store.path, "utf8").trimEnd().split("\n");

      const bumped = { ...JSON.parse(lines[0]!), version: 2 };
      writeFileSync(store.path, `${JSON.stringify(bumped)}\n${lines.slice(1).join("\n")}\n`);
      expect(() => store.load()).toThrow("unsupported workspace header");

      writeFileSync(store.path, `${lines.join("\n")}\n{ not json\n`);
      expect(() => store.load()).toThrow("invalid JSON");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reclaims a stale lock left by a dead process", async () => {
    const { root, workspace, notes } = temporaryWorkspace();
    const store = new NoteStore(workspace, notes);
    try {
      mkdirSync(notes, { recursive: true });
      const lockPath = `${store.path}.lock`;
      mkdirSync(lockPath, { recursive: true });
      const stale = new Date(Date.now() - 60_000).toISOString(); // older than STALE_LOCK_MS (30s)
      writeFileSync(
        join(lockPath, "owner.json"),
        JSON.stringify({ pid: 999999, createdAt: stale }),
      );

      await store.add("after stale lock");
      expect(store.load().map((note) => note.text)).toEqual(["after stale lock"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
