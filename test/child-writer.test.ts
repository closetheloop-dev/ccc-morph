import { describe, expect, test } from "bun:test";
import { ChildWriter } from "../src/child-writer";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("ChildWriter", () => {
  test("a fully accepted write is delivered immediately, nothing queued", async () => {
    const sink: number[] = [];
    const writer = new ChildWriter((data) => {
      sink.push(...data);
      return data.length; // accept everything
    });
    expect(writer.write(bytes("hello"))).toBe(true);
    expect(writer.pending).toBe(false);
    expect(await writer.drained()).toBe(true);
    expect(new TextDecoder().decode(Uint8Array.from(sink))).toBe("hello");
  });

  test("a partial write queues the remainder and drains once the PTY accepts it", async () => {
    let accept = 2; // PTY takes only 2 bytes per call at first
    const sink: number[] = [];
    const writer = new ChildWriter((data) => {
      const take = Math.min(accept, data.length);
      for (let i = 0; i < take; i += 1) sink.push(data[i]!);
      return take;
    });

    expect(writer.write(bytes("abcdef"))).toBe(true);
    expect(writer.pending).toBe(true); // "cdef" still queued

    // The delivery promise is still unresolved while bytes remain queued.
    let delivered: boolean | undefined;
    void writer.drained().then((value) => {
      delivered = value;
    });
    await Bun.sleep(0);
    expect(delivered).toBeUndefined();

    // The PTY becomes fully writable; a flush completes delivery and resolves drained().
    accept = 100;
    writer.flush();
    expect(writer.pending).toBe(false);
    expect(await writer.drained()).toBe(true);
    await Bun.sleep(0);
    expect(delivered).toBe(true);
    expect(new TextDecoder().decode(Uint8Array.from(sink))).toBe("abcdef");
  });

  test("queued writes preserve order behind an earlier short write", () => {
    let accept = 1;
    const sink: number[] = [];
    const writer = new ChildWriter((data) => {
      const take = Math.min(accept, data.length);
      for (let i = 0; i < take; i += 1) sink.push(data[i]!);
      return take;
    });
    writer.write(bytes("AB")); // only "A" accepted, "B" queued
    writer.write(bytes("CD")); // fully queued behind "B"
    accept = 100;
    writer.flush();
    expect(new TextDecoder().decode(Uint8Array.from(sink))).toBe("ABCD");
  });

  test("closing with bytes still queued resolves drained() as not delivered", async () => {
    const writer = new ChildWriter((data) => Math.min(1, data.length)); // always 1 byte
    writer.write(bytes("abc")); // "bc" queued
    expect(writer.pending).toBe(true);

    const pendingDrain = writer.drained();
    writer.close(); // the child exited before the queue drained
    expect(await pendingDrain).toBe(false);
    // A fresh drained() after close still reports the undelivered queue as not delivered.
    expect(await writer.drained()).toBe(false);
  });

  test("write() after close is rejected", () => {
    const writer = new ChildWriter((data) => data.length);
    writer.close();
    expect(writer.write(bytes("x"))).toBe(false);
  });

  test("an empty write is rejected and does not resolve as delivered work", () => {
    const writer = new ChildWriter((data) => data.length);
    expect(writer.write(new Uint8Array(0))).toBe(false);
  });
});
