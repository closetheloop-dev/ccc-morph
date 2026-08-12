import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoteStore, type WorkspaceNote } from "../src/note-store";
import { NoteViewer } from "../src/note-viewer";

const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);

afterEach(() => {
  stdout.mockClear();
});

afterAll(() => {
  stdout.mockRestore();
});

function fixture(): { root: string; store: NoteStore } {
  const root = mkdtempSync(join(tmpdir(), "ccc-morph-note-viewer-test-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  return { root, store: new NoteStore(workspace, join(root, "notes")) };
}

describe("note viewer", () => {
  test("selects multiple active notes and submits them chronologically", async () => {
    const { root, store } = fixture();
    try {
      const first = await store.add("first");
      await Bun.sleep(2);
      const second = await store.add("second");
      let submitted: WorkspaceNote[] = [];
      const viewer = new NoteViewer(store, {
        close: () => {},
        submit: async (notes) => {
          submitted = notes;
        },
      });

      viewer.open();
      viewer.handleInput(Uint8Array.of(0x20)); // Select newest ("second").
      viewer.handleInput(Uint8Array.of(0x1b, 0x5b, 0x42)); // Down arrow to older ("first").
      viewer.handleInput(Uint8Array.of(0x20));
      viewer.handleInput(Uint8Array.of(0x0d));
      await Bun.sleep(5);

      expect(submitted.map((note) => note.id)).toEqual([first.id, second.id]);
      expect(viewer.active).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("browses archives, restores notes, and confirms permanent deletion", async () => {
    const { root, store } = fixture();
    try {
      const note = await store.add("archived");
      await store.archive([note.id]);
      const viewer = new NoteViewer(store, { close: () => {}, submit: async () => {} });

      viewer.open();
      viewer.handleInput(Uint8Array.of(0x09)); // Archive tab.
      viewer.handleInput(Uint8Array.of(0x72)); // Restore.
      await Bun.sleep(10);
      expect(store.load()[0]!.archivedAt).toBeNull();

      viewer.handleInput(Uint8Array.of(0x09)); // Active tab.
      viewer.handleInput(Uint8Array.of(0x44)); // D: ask to delete.
      viewer.handleInput(Uint8Array.of(0x79)); // Confirm.
      await Bun.sleep(10);
      expect(store.load()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not submit without an explicit selection", async () => {
    const { root, store } = fixture();
    try {
      await store.add("not selected");
      let submissions = 0;
      const viewer = new NoteViewer(store, {
        close: () => {},
        submit: async () => {
          submissions += 1;
        },
      });
      viewer.open();
      viewer.handleInput(Uint8Array.of(0x0d));
      await Bun.sleep(5);
      expect(submissions).toBe(0);
      expect(viewer.active).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("moves with arrow sequences split across input chunks", async () => {
    const { root, store } = fixture();
    try {
      const first = await store.add("first");
      await Bun.sleep(2);
      await store.add("second");
      let submitted: WorkspaceNote[] = [];
      const viewer = new NoteViewer(store, {
        close: () => {},
        submit: async (notes) => {
          submitted = notes;
        },
      });

      viewer.open();
      viewer.handleInput(Uint8Array.of(0x1b));
      viewer.handleInput(Uint8Array.of(0x5b));
      viewer.handleInput(Uint8Array.of(0x42)); // Down to the older note.
      viewer.handleInput(Uint8Array.of(0x20));
      viewer.handleInput(Uint8Array.of(0x0d));
      await Bun.sleep(5);

      expect(submitted.map((note) => note.id)).toEqual([first.id]);
      expect(viewer.active).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cancels a pending delete on any key other than y", async () => {
    const { root, store } = fixture();
    try {
      const note = await store.add("keep me");
      const viewer = new NoteViewer(store, { close: () => {}, submit: async () => {} });
      viewer.open();
      viewer.handleInput(Uint8Array.of(0x44)); // D: ask to delete
      viewer.handleInput(Uint8Array.of(0x6e)); // n: anything but y cancels
      await Bun.sleep(10);
      expect(store.load().map((n) => n.id)).toEqual([note.id]);
      expect(viewer.active).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("toggling a selection off leaves nothing to submit", async () => {
    const { root, store } = fixture();
    try {
      await store.add("one");
      let submissions = 0;
      const viewer = new NoteViewer(store, {
        close: () => {},
        submit: async () => {
          submissions += 1;
        },
      });
      viewer.open();
      viewer.handleInput(Uint8Array.of(0x20)); // select
      viewer.handleInput(Uint8Array.of(0x20)); // deselect
      viewer.handleInput(Uint8Array.of(0x0d)); // Enter
      await Bun.sleep(5);
      expect(submissions).toBe(0);
      expect(viewer.active).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("q closes the viewer without submitting", async () => {
    const { root, store } = fixture();
    try {
      await store.add("one");
      let closed = 0;
      let submissions = 0;
      const viewer = new NoteViewer(store, {
        close: () => {
          closed += 1;
        },
        submit: async () => {
          submissions += 1;
        },
      });
      viewer.open();
      viewer.handleInput(Uint8Array.of(0x20)); // select something first
      viewer.handleInput(Uint8Array.of(0x71)); // q
      await Bun.sleep(5);
      expect(closed).toBe(1);
      expect(submissions).toBe(0);
      expect(viewer.active).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("arrow keys move the cursor between notes", async () => {
    const { root, store } = fixture();
    try {
      await store.add("first");
      await Bun.sleep(2);
      const second = await store.add("second");
      let submitted: WorkspaceNote[] = [];
      const viewer = new NoteViewer(store, {
        close: () => {},
        submit: async (notes) => {
          submitted = notes;
        },
      });
      viewer.open(); // newest-first: cursor on "second"
      viewer.handleInput(Uint8Array.of(0x1b, 0x5b, 0x42)); // Down to "first"
      viewer.handleInput(Uint8Array.of(0x1b, 0x5b, 0x41)); // Up back to "second"
      viewer.handleInput(Uint8Array.of(0x20)); // select current
      viewer.handleInput(Uint8Array.of(0x0d));
      await Bun.sleep(5);
      expect(submitted.map((n) => n.id)).toEqual([second.id]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("scrolls a long note's preview without changing the selection", async () => {
    const { root, store } = fixture();
    try {
      const body = Array.from({ length: 40 }, (_, i) => `L${String(i).padStart(2, "0")}`).join(
        "\n",
      );
      await store.add(body);
      const viewer = new NoteViewer(store, { close: () => {}, submit: async () => {} });

      viewer.open();
      const before = String(stdout.mock.calls.at(-1)?.[0] ?? "");
      expect(before).toContain("L00"); // top of the note is visible
      expect(before).not.toContain("L39"); // last line is below the fold

      viewer.handleInput(Uint8Array.of(0x66)); // f: page down
      viewer.handleInput(Uint8Array.of(0x66));
      viewer.handleInput(Uint8Array.of(0x66));
      viewer.handleInput(Uint8Array.of(0x66));
      const after = String(stdout.mock.calls.at(-1)?.[0] ?? "");
      expect(after).toContain("L39"); // scrolled the preview to the end
      viewer.handleInput(Uint8Array.of(0x75)); // u: half page up moves back off the end
      expect(String(stdout.mock.calls.at(-1)?.[0] ?? "")).not.toContain("L39");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("g and G jump to the top and bottom of a long note", async () => {
    const { root, store } = fixture();
    try {
      const body = Array.from({ length: 40 }, (_, i) => `L${String(i).padStart(2, "0")}`).join(
        "\n",
      );
      await store.add(body);
      const viewer = new NoteViewer(store, { close: () => {}, submit: async () => {} });

      viewer.open();
      viewer.handleInput(Uint8Array.of(0x47)); // G: jump to the bottom
      expect(String(stdout.mock.calls.at(-1)?.[0] ?? "")).toContain("L39");
      viewer.handleInput(Uint8Array.of(0x67)); // g: jump back to the top
      const top = String(stdout.mock.calls.at(-1)?.[0] ?? "");
      expect(top).toContain("L00");
      expect(top).not.toContain("L39");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("e invokes the edit control with the current note", async () => {
    const { root, store } = fixture();
    try {
      const note = await store.add("original");
      let editedId = "";
      const viewer = new NoteViewer(store, {
        close: () => {},
        submit: async () => {},
        edit: async (n) => {
          editedId = n.id;
          await store.update(n.id, "rewritten");
        },
      });

      viewer.open();
      viewer.handleInput(Uint8Array.of(0x65)); // e
      await Bun.sleep(5);
      expect(editedId).toBe(note.id);
      expect(store.load()[0]!.text).toBe("rewritten");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a invokes the add control from inside the picker", async () => {
    const { root, store } = fixture();
    try {
      await store.add("existing");
      let added = 0;
      const ref: { viewer?: NoteViewer } = {};
      ref.viewer = new NoteViewer(store, {
        close: () => {},
        submit: async () => {},
        add: async () => {
          added += 1;
          await store.add("added note");
          ref.viewer?.refresh();
        },
      });

      ref.viewer.open();
      ref.viewer.handleInput(Uint8Array.of(0x61)); // a: add
      await Bun.sleep(5);

      expect(added).toBe(1);
      expect(
        store
          .load()
          .map((n) => n.text)
          .sort(),
      ).toEqual(["added note", "existing"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("c invokes the capture control from inside the picker", async () => {
    const { root, store } = fixture();
    try {
      let captured = 0;
      const ref: { viewer?: NoteViewer } = {};
      ref.viewer = new NoteViewer(store, {
        close: () => {},
        submit: async () => {},
        capture: async () => {
          captured += 1;
          await store.add("captured note");
          ref.viewer?.refresh();
        },
      });

      ref.viewer.open();
      ref.viewer.handleInput(Uint8Array.of(0x63)); // c: capture output
      await Bun.sleep(5);

      expect(captured).toBe(1);
      expect(store.load().map((n) => n.text)).toEqual(["captured note"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refresh reloads the store and keeps the picker active", async () => {
    const { root, store } = fixture();
    try {
      await store.add("one");
      const viewer = new NoteViewer(store, { close: () => {}, submit: async () => {} });
      viewer.open();
      await store.add("two"); // added behind the viewer's back
      viewer.refresh("note updated");
      expect(viewer.active).toBe(true);
      const rendered = String(stdout.mock.calls.at(-1)?.[0] ?? "");
      expect(rendered).toContain("[active] 2"); // both notes now listed
      expect(rendered).toContain("note updated"); // status shown in the footer
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("escapes a bare carriage return but keeps CRLF as a clean line break", async () => {
    const { root, store } = fixture();
    try {
      await store.add("alpha\rbravo"); // a bare CR must not move the cursor
      await Bun.sleep(2);
      await store.add("line1\r\nline2"); // a CRLF is a real line break, not an escaped \x0d
      const viewer = new NoteViewer(store, { close: () => {}, submit: async () => {} });
      viewer.open();
      const rendered = String(stdout.mock.calls.at(-1)?.[0] ?? "");
      // Bare CR is escaped inline.
      expect(rendered).toContain("alpha\\x0dbravo");
      // CRLF is a real line break, not an escaped \x0d: the newest note is previewed, so
      // both of its lines render, and the first-line summary carries no leftover \x0d.
      expect(rendered).toContain("line1");
      expect(rendered).toContain("line2");
      expect(rendered).not.toContain("line1\\x0d");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores restore on the active tab and select/submit on the archive tab", async () => {
    const { root, store } = fixture();
    try {
      const active = await store.add("active");
      const archived = await store.add("archived");
      await store.archive([archived.id]);
      let submissions = 0;
      const viewer = new NoteViewer(store, {
        close: () => {},
        submit: async () => {
          submissions += 1;
        },
      });
      viewer.open(); // active tab, cursor on "active"
      viewer.handleInput(Uint8Array.of(0x72)); // r: only valid on the archive tab
      await Bun.sleep(10);
      expect(store.load().find((n) => n.id === active.id)!.archivedAt).toBeNull();

      viewer.handleInput(Uint8Array.of(0x09)); // Tab -> archive
      viewer.handleInput(Uint8Array.of(0x20)); // Space: only valid on the active tab
      viewer.handleInput(Uint8Array.of(0x0d)); // Enter: only valid on the active tab
      await Bun.sleep(5);
      expect(submissions).toBe(0);
      expect(viewer.active).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
