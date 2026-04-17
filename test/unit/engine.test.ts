import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeChanges } from "../../src/core/engine.js";

describe("computeChanges — three-way diff", () => {
  const ROOT = "test-root";

  it("detects file added locally", () => {
    const local = new Map([["new.md", "hash-new"]]);
    const repo = new Map<string, string>();
    const state = {};

    const changes = computeChanges(ROOT, local, repo, state);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].action, "added");
    assert.equal(changes[0].side, "local");
    assert.equal(changes[0].relativePath, "new.md");
  });

  it("detects file added in repo", () => {
    const local = new Map<string, string>();
    const repo = new Map([["new.md", "hash-new"]]);
    const state = {};

    const changes = computeChanges(ROOT, local, repo, state);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].action, "added");
    assert.equal(changes[0].side, "repo");
  });

  it("detects conflict when added on both sides with different content", () => {
    const local = new Map([["new.md", "hash-local"]]);
    const repo = new Map([["new.md", "hash-repo"]]);
    const state = {};

    const changes = computeChanges(ROOT, local, repo, state);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].action, "conflict");
    assert.equal(changes[0].side, "both");
  });

  it("skips when added on both sides with same content", () => {
    const local = new Map([["new.md", "hash-same"]]);
    const repo = new Map([["new.md", "hash-same"]]);
    const state = {};

    const changes = computeChanges(ROOT, local, repo, state);
    assert.equal(changes.length, 0);
  });

  it("detects file modified locally", () => {
    const local = new Map([["file.md", "hash-new"]]);
    const repo = new Map([["file.md", "hash-old"]]);
    const state = { "file.md": { hash: "hash-old" } };

    const changes = computeChanges(ROOT, local, repo, state);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].action, "modified");
    assert.equal(changes[0].side, "local");
  });

  it("detects file modified in repo", () => {
    const local = new Map([["file.md", "hash-old"]]);
    const repo = new Map([["file.md", "hash-new"]]);
    const state = { "file.md": { hash: "hash-old" } };

    const changes = computeChanges(ROOT, local, repo, state);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].action, "modified");
    assert.equal(changes[0].side, "repo");
  });

  it("detects conflict when modified on both sides", () => {
    const local = new Map([["file.md", "hash-local"]]);
    const repo = new Map([["file.md", "hash-repo"]]);
    const state = { "file.md": { hash: "hash-old" } };

    const changes = computeChanges(ROOT, local, repo, state);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].action, "conflict");
    assert.equal(changes[0].side, "both");
  });

  it("skips when modified on both sides to same content", () => {
    const local = new Map([["file.md", "hash-same"]]);
    const repo = new Map([["file.md", "hash-same"]]);
    const state = { "file.md": { hash: "hash-old" } };

    const changes = computeChanges(ROOT, local, repo, state);
    assert.equal(changes.length, 0);
  });

  it("detects file deleted locally", () => {
    const local = new Map<string, string>();
    const repo = new Map([["file.md", "hash-old"]]);
    const state = { "file.md": { hash: "hash-old" } };

    const changes = computeChanges(ROOT, local, repo, state);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].action, "deleted");
    assert.equal(changes[0].side, "local");
  });

  it("detects file deleted in repo", () => {
    const local = new Map([["file.md", "hash-old"]]);
    const repo = new Map<string, string>();
    const state = { "file.md": { hash: "hash-old" } };

    const changes = computeChanges(ROOT, local, repo, state);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].action, "deleted");
    assert.equal(changes[0].side, "repo");
  });

  it("skips file deleted on both sides", () => {
    const local = new Map<string, string>();
    const repo = new Map<string, string>();
    const state = { "file.md": { hash: "hash-old" } };

    const changes = computeChanges(ROOT, local, repo, state);
    assert.equal(changes.length, 0);
  });

  it("skips unchanged files", () => {
    const local = new Map([["file.md", "hash-same"]]);
    const repo = new Map([["file.md", "hash-same"]]);
    const state = { "file.md": { hash: "hash-same" } };

    const changes = computeChanges(ROOT, local, repo, state);
    assert.equal(changes.length, 0);
  });

  it("handles multiple files with mixed changes", () => {
    const local = new Map([
      ["unchanged.md", "hash-a"],
      ["modified-local.md", "hash-new"],
      ["added-local.md", "hash-added"],
    ]);
    const repo = new Map([
      ["unchanged.md", "hash-a"],
      ["modified-local.md", "hash-old"],
      ["added-repo.md", "hash-repo"],
    ]);
    const state = {
      "unchanged.md": { hash: "hash-a" },
      "modified-local.md": { hash: "hash-old" },
      "deleted-both.md": { hash: "hash-gone" },
    };

    const changes = computeChanges(ROOT, local, repo, state);

    const byPath = new Map(changes.map((c) => [c.relativePath, c]));
    assert.ok(!byPath.has("unchanged.md"));
    assert.ok(!byPath.has("deleted-both.md"));
    assert.equal(byPath.get("modified-local.md")?.action, "modified");
    assert.equal(byPath.get("modified-local.md")?.side, "local");
    assert.equal(byPath.get("added-local.md")?.action, "added");
    assert.equal(byPath.get("added-local.md")?.side, "local");
    assert.equal(byPath.get("added-repo.md")?.action, "added");
    assert.equal(byPath.get("added-repo.md")?.side, "repo");
  });

  it("returns sorted results", () => {
    const local = new Map([
      ["z-file.md", "hash-z"],
      ["a-file.md", "hash-a"],
      ["m-file.md", "hash-m"],
    ]);
    const repo = new Map<string, string>();
    const state = {};

    const changes = computeChanges(ROOT, local, repo, state);
    const paths = changes.map((c) => c.relativePath);
    assert.deepEqual(paths, ["a-file.md", "m-file.md", "z-file.md"]);
  });
});
