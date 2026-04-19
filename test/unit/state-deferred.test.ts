import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  emptyState,
  setDeferred,
  clearDeferred,
  removeFromState,
} from "../../src/core/state.js";

describe("deferred field", () => {
  it("emptyState includes empty deferred map", () => {
    const s = emptyState();
    assert.deepEqual(s.deferred, {});
  });

  it("setDeferred adds a key with reason and timestamp", () => {
    const s = setDeferred(emptyState(), "claude/a.md", "conflict");
    assert.equal(s.deferred?.["claude/a.md"]?.reason, "conflict");
    assert.ok(s.deferred?.["claude/a.md"]?.capturedAt);
  });

  it("setDeferred is idempotent (overwrites timestamp but stays one entry)", () => {
    let s = setDeferred(emptyState(), "claude/a.md");
    s = setDeferred(s, "claude/a.md");
    assert.equal(Object.keys(s.deferred ?? {}).length, 1);
  });

  it("clearDeferred removes the key", () => {
    let s = setDeferred(emptyState(), "claude/a.md");
    s = clearDeferred(s, "claude/a.md");
    assert.equal(s.deferred?.["claude/a.md"], undefined);
  });

  it("clearDeferred on missing key is a no-op", () => {
    const s = clearDeferred(emptyState(), "nope");
    assert.deepEqual(s.deferred, {});
  });

  it("removeFromState also clears deferral for the same path", () => {
    let s = emptyState();
    s.files["claude/a.md"] = { hash: "h", size: 0, syncedAt: "now" };
    s = setDeferred(s, "claude/a.md");
    s = removeFromState(s, "claude", ["a.md"]);
    assert.equal(s.files["claude/a.md"], undefined);
    assert.equal(s.deferred?.["claude/a.md"], undefined);
  });

  it("setDeferred / clearDeferred return new objects (immutable)", () => {
    const s1 = emptyState();
    const s2 = setDeferred(s1, "k");
    assert.notEqual(s1, s2);
    assert.notEqual(s1.deferred, s2.deferred);
    const s3 = clearDeferred(s2, "k");
    assert.notEqual(s2, s3);
  });
});
