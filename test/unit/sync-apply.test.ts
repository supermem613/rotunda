import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planApply } from "../../src/sync/apply.js";
import type { Row } from "../../src/tui/state.js";
import type { FileChange } from "../../src/core/types.js";

function row(action: Row["action"], over: Partial<FileChange> = {}, mergedContent?: string): Row {
  return {
    change: {
      relativePath: over.relativePath ?? "a.md",
      rootName: over.rootName ?? "claude",
      action: over.action ?? "added",
      side: over.side ?? "local",
      localHash: over.localHash ?? "lh",
      repoHash: over.repoHash,
      stateHash: over.stateHash,
    },
    action,
    mergedContent,
  };
}

describe("planApply", () => {
  it("drops skip and conflict rows", () => {
    const plan = planApply([
      row("push"),
      row("skip"),
      row("conflict"),
      row("pull"),
    ]);
    assert.equal(plan.ops.length, 2);
    assert.deepEqual(plan.ops.map((o) => o.kind), ["push", "pull"]);
  });

  it("counts git vs local touches", () => {
    const plan = planApply([
      row("push"),
      row("pull"),
      row("merge", {}, "merged"),
      row("delete-local"),
      row("delete-repo"),
    ]);
    assert.equal(plan.gitTouches, 3); // push + merge + delete-repo
    assert.equal(plan.localTouches, 3); // pull + merge + delete-local
  });

  it("empty plan when only skip/conflict present", () => {
    const plan = planApply([row("skip"), row("conflict")]);
    assert.equal(plan.ops.length, 0);
    assert.equal(plan.gitTouches, 0);
    assert.equal(plan.localTouches, 0);
  });
});
