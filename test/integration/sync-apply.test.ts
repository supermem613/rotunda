import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeApply, planApply } from "../../src/sync/apply.js";
import { emptyState } from "../../src/core/state.js";
import { hashContent } from "../../src/utils/hash.js";
import type { Manifest, FileChange } from "../../src/core/types.js";
import type { Row } from "../../src/tui/state.js";

const TMP = join(tmpdir(), "rotunda-apply-test");
const REPO = join(TMP, "repo");
const LOCAL = join(TMP, "local");

function setup() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(REPO, "claude"), { recursive: true });
  mkdirSync(join(LOCAL), { recursive: true });
}

function cleanup() {
  rmSync(TMP, { recursive: true, force: true });
}

function manifest(): Manifest {
  return {
    version: 1,
    roots: [{
      name: "claude",
      local: LOCAL,
      repo: "claude",
      include: ["**"],
      exclude: [],
    }],
    globalExclude: [],
  };
}

function row(action: Row["action"], change: FileChange, mergedContent?: string): Row {
  return { change, action, mergedContent };
}

describe("executeApply", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("push copies local → repo and stages git path", async () => {
    writeFileSync(join(LOCAL, "a.md"), "hello");
    const change: FileChange = {
      relativePath: "a.md", rootName: "claude", action: "added", side: "local",
      localHash: hashContent("hello"),
    };
    const plan = planApply([row("push", change)]);
    const r = await executeApply(plan, manifest(), REPO, emptyState());
    assert.equal(readFileSync(join(REPO, "claude", "a.md"), "utf-8"), "hello");
    assert.deepEqual(r.gitPaths, [join("claude", "a.md")]);
    assert.ok(r.state.files["claude/a.md"]);
    assert.equal(r.state.files["claude/a.md"].hash, hashContent("hello"));
  });

  it("pull copies repo → local", async () => {
    mkdirSync(join(REPO, "claude"), { recursive: true });
    writeFileSync(join(REPO, "claude", "b.md"), "world");
    const change: FileChange = {
      relativePath: "b.md", rootName: "claude", action: "added", side: "repo",
      repoHash: hashContent("world"),
    };
    const plan = planApply([row("pull", change)]);
    const r = await executeApply(plan, manifest(), REPO, emptyState());
    assert.equal(readFileSync(join(LOCAL, "b.md"), "utf-8"), "world");
    assert.equal(r.gitPaths.length, 0);
  });

  it("delete-local removes file and clears state", async () => {
    writeFileSync(join(LOCAL, "c.md"), "x");
    const change: FileChange = {
      relativePath: "c.md", rootName: "claude", action: "deleted", side: "repo",
      stateHash: "h",
    };
    let s = emptyState();
    s.files["claude/c.md"] = { hash: "h", size: 0, syncedAt: "now" };
    const plan = planApply([row("delete-local", change)]);
    const r = await executeApply(plan, manifest(), REPO, s);
    assert.equal(existsSync(join(LOCAL, "c.md")), false);
    assert.equal(r.state.files["claude/c.md"], undefined);
  });

  it("merge writes merged content to BOTH sides and hashes the merged bytes", async () => {
    mkdirSync(join(REPO, "claude"), { recursive: true });
    writeFileSync(join(LOCAL, "m.md"), "local");
    writeFileSync(join(REPO, "claude", "m.md"), "repo");
    const merged = "MERGED CONTENT";
    const change: FileChange = {
      relativePath: "m.md", rootName: "claude", action: "conflict", side: "both",
      localHash: "lh", repoHash: "rh", stateHash: "sh",
    };
    const plan = planApply([row("merge", change, merged)]);
    const r = await executeApply(plan, manifest(), REPO, emptyState());
    assert.equal(readFileSync(join(LOCAL, "m.md"), "utf-8"), merged);
    assert.equal(readFileSync(join(REPO, "claude", "m.md"), "utf-8"), merged);
    assert.deepEqual(r.gitPaths, [join("claude", "m.md")]);
    assert.equal(r.state.files["claude/m.md"].hash, hashContent(merged));
  });

  it("defer snapshots files into .rotunda/conflicts and marks state.deferred", async () => {
    mkdirSync(join(REPO, "claude"), { recursive: true });
    writeFileSync(join(LOCAL, "d.md"), "local-side");
    writeFileSync(join(REPO, "claude", "d.md"), "repo-side");
    const change: FileChange = {
      relativePath: "d.md", rootName: "claude", action: "conflict", side: "both",
      localHash: "lh", repoHash: "rh", stateHash: "sh",
    };
    const plan = planApply([row("defer", change)]);
    const r = await executeApply(plan, manifest(), REPO, emptyState());
    const dir = join(REPO, ".rotunda", "conflicts", "claude", "d.md");
    assert.equal(readFileSync(join(dir, "local"), "utf-8"), "local-side");
    assert.equal(readFileSync(join(dir, "repo"), "utf-8"), "repo-side");
    assert.ok(r.state.deferred?.["claude/d.md"]);
    // Snapshot must NOT be a sibling that the next sync would re-discover.
    assert.equal(existsSync(join(LOCAL, "d.md.local")), false);
    assert.equal(existsSync(join(REPO, "claude", "d.md.repo")), false);
  });

  it("skip and conflict ops are dropped at planApply, not executed", async () => {
    const change: FileChange = {
      relativePath: "z.md", rootName: "claude", action: "conflict", side: "both",
      localHash: "lh", repoHash: "rh",
    };
    const plan = planApply([row("conflict", change), row("skip", change)]);
    const r = await executeApply(plan, manifest(), REPO, emptyState());
    assert.equal(r.gitPaths.length, 0);
    assert.equal(r.log.length, 0);
  });

  it("keep-local pushes local content (resolved conflict)", async () => {
    writeFileSync(join(LOCAL, "k.md"), "L");
    const change: FileChange = {
      relativePath: "k.md", rootName: "claude", action: "conflict", side: "both",
      localHash: hashContent("L"), repoHash: "rh",
    };
    const plan = planApply([row("keep-local", change)]);
    const r = await executeApply(plan, manifest(), REPO, emptyState());
    assert.equal(readFileSync(join(REPO, "claude", "k.md"), "utf-8"), "L");
    assert.deepEqual(r.gitPaths, [join("claude", "k.md")]);
    assert.equal(r.state.files["claude/k.md"].hash, hashContent("L"));
  });
});
