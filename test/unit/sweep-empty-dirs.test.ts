import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sweepEmptyDirsUnderBoundary } from "../../src/sync/apply.js";

const TMP = join(tmpdir(), "rotunda-sweep-test");

function setup(): void {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

function cleanup(): void {
  rmSync(TMP, { recursive: true, force: true });
}

describe("sweepEmptyDirsUnderBoundary", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("removes a freshly created empty subtree the user dropped under the boundary", async () => {
    // This is the bug the user reported: an empty foo/ under .copilot/skills
    // should be swept even though no file deletes happened in the sync.
    const boundary = join(TMP, "skills");
    mkdirSync(join(boundary, "foo", "bar"), { recursive: true });
    const removed = await sweepEmptyDirsUnderBoundary(boundary);
    assert.deepEqual(removed, ["foo/bar", "foo"]);
    assert.ok(existsSync(boundary), "boundary itself must survive");
    assert.ok(!existsSync(join(boundary, "foo")));
  });

  it("preserves the boundary even when it ends up empty", async () => {
    // Boundaries are explicit user opt-ins; never remove them.
    const boundary = join(TMP, "skills");
    mkdirSync(join(boundary, "foo"), { recursive: true });
    await sweepEmptyDirsUnderBoundary(boundary);
    assert.ok(existsSync(boundary), "boundary survives");
  });

  it("leaves non-empty branches alone and only sweeps adjacent empty ones", async () => {
    const boundary = join(TMP, "skills");
    mkdirSync(join(boundary, "keep"), { recursive: true });
    writeFileSync(join(boundary, "keep", "real.txt"), "stay");
    mkdirSync(join(boundary, "drop", "deep"), { recursive: true });
    const removed = await sweepEmptyDirsUnderBoundary(boundary);
    assert.deepEqual(removed.sort(), ["drop", "drop/deep"].sort());
    assert.ok(existsSync(join(boundary, "keep", "real.txt")));
    assert.ok(!existsSync(join(boundary, "drop")));
  });

  it("returns an empty list when the boundary itself does not exist", async () => {
    // User configured prune sub-path that has no presence on this side yet.
    const boundary = join(TMP, "ghost");
    const removed = await sweepEmptyDirsUnderBoundary(boundary);
    assert.deepEqual(removed, []);
  });

  it("does not descend into a boundary that is a file (no-op)", async () => {
    const boundary = join(TMP, "skills");
    mkdirSync(TMP, { recursive: true });
    writeFileSync(boundary, "not a directory");
    const removed = await sweepEmptyDirsUnderBoundary(boundary);
    assert.deepEqual(removed, []);
    assert.ok(existsSync(boundary));
  });

  it("collapses a deep chain even when intermediate dirs are emptied by the walk", async () => {
    const boundary = join(TMP, "skills");
    mkdirSync(join(boundary, "a", "b", "c", "d"), { recursive: true });
    const removed = await sweepEmptyDirsUnderBoundary(boundary);
    // Deepest-first order from the post-order traversal.
    assert.deepEqual(removed, ["a/b/c/d", "a/b/c", "a/b", "a"]);
    assert.ok(existsSync(boundary));
    assert.ok(!existsSync(join(boundary, "a")));
  });
});
