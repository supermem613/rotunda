import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pruneEmptyParents } from "../../src/sync/apply.js";

const TMP = join(tmpdir(), "rotunda-prune-test");

function setup(): void {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

function cleanup(): void {
  rmSync(TMP, { recursive: true, force: true });
}

describe("pruneEmptyParents", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("collapses a nested chain of empty directories up to but not including the boundary", async () => {
    const root = join(TMP, "root");
    const deep = join(root, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    const file = join(deep, "x.txt");
    // The caller deletes the file first — simulate the same precondition.
    // We never create the file here; pruneEmptyParents only inspects parents.
    const removed = await pruneEmptyParents(file, root);
    assert.deepEqual(removed, ["a/b/c", "a/b", "a"]);
    assert.ok(existsSync(root), "root must not be removed");
    assert.ok(!existsSync(join(root, "a")), "a should be pruned");
  });

  it("stops at the first non-empty directory", async () => {
    const root = join(TMP, "root");
    const deep = join(root, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    // Sibling file in `a` keeps it non-empty after `a/b/c` collapses.
    writeFileSync(join(root, "a", "sibling.txt"), "keep me");
    const file = join(deep, "x.txt");
    const removed = await pruneEmptyParents(file, root);
    assert.deepEqual(removed, ["a/b/c", "a/b"]);
    assert.ok(existsSync(join(root, "a")), "a must survive because of sibling");
    assert.ok(existsSync(join(root, "a", "sibling.txt")), "sibling untouched");
    assert.ok(!existsSync(join(root, "a", "b")), "b should be pruned");
  });

  it("never removes the root boundary itself even when it is empty", async () => {
    const root = join(TMP, "root");
    mkdirSync(root, { recursive: true });
    // File directly under root: dirname(file) === root, which is the boundary.
    const file = join(root, "x.txt");
    const removed = await pruneEmptyParents(file, root);
    assert.deepEqual(removed, []);
    assert.ok(existsSync(root), "root must not be removed");
  });

  it("returns no-op when the immediate parent is non-empty", async () => {
    const root = join(TMP, "root");
    const dir = join(root, "a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "keep.txt"), "keep");
    const file = join(dir, "deleted.txt");
    const removed = await pruneEmptyParents(file, root);
    assert.deepEqual(removed, []);
    assert.ok(existsSync(dir), "non-empty parent must remain");
  });

  it("does not walk above the root boundary even when the parent chain extends higher", async () => {
    // Build TMP/outer/root/a/b/x.txt with the boundary set at TMP/outer/root.
    // Pruning must not touch TMP/outer even if it ends up empty.
    const outer = join(TMP, "outer");
    const root = join(outer, "root");
    const deep = join(root, "a", "b");
    mkdirSync(deep, { recursive: true });
    const file = join(deep, "x.txt");
    const removed = await pruneEmptyParents(file, root);
    assert.deepEqual(removed, ["a/b", "a"]);
    assert.ok(existsSync(root), "root preserved");
    assert.ok(existsSync(outer), "outer preserved");
  });
});
