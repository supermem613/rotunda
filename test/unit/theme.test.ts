import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sideEffect, actionLabel, actionEffect } from "../../src/tui/theme.js";
import type { ResolvedAction } from "../../src/tui/state.js";

const ALL_ACTIONS: ResolvedAction[] = [
  "push", "pull", "delete-local", "delete-repo",
  "keep-local", "keep-repo", "merge", "defer", "skip", "conflict",
];

describe("sideEffect", () => {
  it("push and keep-local write to repo only", () => {
    assert.deepEqual(sideEffect("push"),       { local: "none",  repo: "write" });
    assert.deepEqual(sideEffect("keep-local"), { local: "none",  repo: "write" });
  });

  it("pull and keep-repo write to local only", () => {
    assert.deepEqual(sideEffect("pull"),     { local: "write", repo: "none" });
    assert.deepEqual(sideEffect("keep-repo"), { local: "write", repo: "none" });
  });

  it("delete-local deletes local only", () => {
    assert.deepEqual(sideEffect("delete-local"), { local: "delete", repo: "none" });
  });

  it("delete-repo deletes repo only", () => {
    assert.deepEqual(sideEffect("delete-repo"), { local: "none", repo: "delete" });
  });

  it("merge writes both sides", () => {
    assert.deepEqual(sideEffect("merge"), { local: "write", repo: "write" });
  });

  it("defer / skip / conflict touch nothing", () => {
    assert.deepEqual(sideEffect("defer"),    { local: "none", repo: "none" });
    assert.deepEqual(sideEffect("skip"),     { local: "none", repo: "none" });
    assert.deepEqual(sideEffect("conflict"), { local: "none", repo: "none" });
  });

  it("is exhaustive — every ResolvedAction has a defined effect", () => {
    for (const a of ALL_ACTIONS) {
      const e = sideEffect(a);
      assert.ok(["write", "delete", "none"].includes(e.local), `local op for ${a}`);
      assert.ok(["write", "delete", "none"].includes(e.repo),  `repo op for ${a}`);
    }
  });

  it("a touch on a side is reflected in the action label", () => {
    // Sanity: actions whose label hints at deletion actually delete.
    assert.equal(sideEffect("delete-local").local, "delete");
    assert.equal(sideEffect("delete-repo").repo,  "delete");
    // And actions whose label hints at transfer actually write.
    assert.equal(sideEffect("push").repo,  "write");
    assert.equal(sideEffect("pull").local, "write");
  });
});

describe("actionLabel / actionEffect coverage", () => {
  it("returns a non-empty label and effect for every action", () => {
    for (const a of ALL_ACTIONS) {
      assert.ok(actionLabel(a).length > 0, `label for ${a}`);
      assert.ok(actionEffect(a).length > 0, `effect for ${a}`);
    }
  });
});
