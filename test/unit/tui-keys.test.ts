import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { attachFastEscape, normalizeKey } from "../../src/tui/keys.js";
import type { Key } from "../../src/tui/state.js";

describe("normalizeKey", () => {
  it("maps return → enter", () => {
    assert.equal(normalizeKey(undefined, { name: "return" }).name, "enter");
  });

  it("maps bare space to 'space'", () => {
    assert.equal(normalizeKey(" ", undefined).name, "space");
  });

  it("normalises escape via raw.name", () => {
    assert.equal(
      normalizeKey(undefined, { name: "escape", sequence: "\x1b" }).name,
      "escape",
    );
  });

  it("normalises escape when only str='\\x1b' is provided", () => {
    assert.equal(normalizeKey("\x1b", undefined).name, "escape");
  });

  it("normalises escape via raw.sequence='\\x1b' alone", () => {
    assert.equal(
      normalizeKey(undefined, { sequence: "\x1b" } as never).name,
      "escape",
    );
  });

  it("preserves ctrl flag", () => {
    const key = normalizeKey(undefined, { name: "c", ctrl: true });
    assert.equal(key.name, "c");
    assert.equal(key.ctrl, true);
  });
});

// A minimal stand-in for NodeJS.ReadStream that supports just the .on/.off
// surface attachFastEscape uses. This keeps the fast-escape tests from
// needing a real TTY, which isn't available in CI.
type FakeStream = EventEmitter & {
  emitData: (chunk: Buffer) => void;
};

function fakeStream(): FakeStream {
  const ee = new EventEmitter() as FakeStream;
  ee.emitData = (chunk: Buffer) => ee.emit("data", chunk);
  return ee;
}

async function wait(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("attachFastEscape", () => {
  it("emits escape immediately when a lone \\x1b byte is the whole chunk", async () => {
    const s = fakeStream();
    const keys: Key[] = [];
    const fe = attachFastEscape(s as unknown as NodeJS.ReadStream, (k) => keys.push(k), 10);

    s.emitData(Buffer.from([0x1b]));
    // Before the timer fires, nothing has been emitted yet.
    assert.equal(keys.length, 0);
    await wait(25);
    assert.equal(keys.length, 1);
    assert.equal(keys[0].name, "escape");

    // Readline would fire its own escape ~500 ms later; simulate the
    // dedupe-consume path.
    assert.equal(fe.consumeIfRecent(), true, "recent fast escape must dedupe");
    assert.equal(fe.consumeIfRecent(), false, "marker consumed — second call returns false");
    fe.detach();
  });

  it("does NOT emit fast escape when chunk contains a full CSI sequence", async () => {
    const s = fakeStream();
    const keys: Key[] = [];
    const fe = attachFastEscape(s as unknown as NodeJS.ReadStream, (k) => keys.push(k), 10);

    // Arrow up in a single read — readline will parse this; we must stay silent.
    s.emitData(Buffer.from([0x1b, 0x5b, 0x41]));
    await wait(25);
    assert.equal(keys.length, 0);
    assert.equal(fe.consumeIfRecent(), false);
    fe.detach();
  });

  it("does NOT emit when \\x1b is followed by more bytes before the timer fires", async () => {
    const s = fakeStream();
    const keys: Key[] = [];
    const fe = attachFastEscape(s as unknown as NodeJS.ReadStream, (k) => keys.push(k), 50);

    // Simulate an arrow key whose bytes arrive in two reads (e.g., SSH/PTY).
    s.emitData(Buffer.from([0x1b]));
    await wait(5);
    s.emitData(Buffer.from([0x5b, 0x41])); // '[A' — completes arrow-up
    await wait(60);
    assert.equal(keys.length, 0, "fast escape must be cancelled by continuation bytes");
    assert.equal(fe.consumeIfRecent(), false);
    fe.detach();
  });

  it("detach cancels a pending escape timer", async () => {
    const s = fakeStream();
    const keys: Key[] = [];
    const fe = attachFastEscape(s as unknown as NodeJS.ReadStream, (k) => keys.push(k), 20);
    s.emitData(Buffer.from([0x1b]));
    fe.detach();
    await wait(40);
    assert.equal(keys.length, 0, "timer must not fire after detach");
  });

  it("accepts string chunks (some terminals deliver data as decoded strings)", async () => {
    const s = fakeStream();
    const keys: Key[] = [];
    const fe = attachFastEscape(s as unknown as NodeJS.ReadStream, (k) => keys.push(k), 10);
    s.emit("data", "\x1b");
    await wait(25);
    assert.equal(keys.length, 1);
    assert.equal(keys[0].name, "escape");
    fe.detach();
  });
});
