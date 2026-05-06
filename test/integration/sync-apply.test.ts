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
    const s = emptyState();
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

// Regression for the ENOENT-on-bulk-resolve bug. The TUI reducer now maps
// delete-vs-modify conflicts to delete-* (not keep-*) when the winner side
// is empty; this proves the apply pass succeeds end-to-end through the same
// path the user hits in `rotunda sync`.
describe("executeApply — delete-vs-modify conflicts via TUI bulk resolve", () => {
  beforeEach(setup);
  afterEach(cleanup);

  async function applyThroughBulk(
    change: FileChange,
    bulkKey: "1" | "2",
    initial: ReturnType<typeof emptyState>,
  ) {
    // Round-trip through the same code path the user hits in `rotunda sync`:
    // initialState → bulk reduce (1=repo-wins / 2=local-wins) → planApply →
    // executeApply. If the reducer mis-maps the conflict, executeApply
    // crashes with ENOENT.
    const { initialState: makeState, reduce } = await import("../../src/tui/state.js");
    const s0 = makeState([change], { cols: 80, rows: 24 });
    const s1 = reduce(s0, { type: "key", key: { name: bulkKey } });
    const plan = planApply(s1.rows);
    return { resolved: s1.rows[0].action, exec: await executeApply(plan, manifest(), REPO, initial) };
  }

  it("repo-wins on (repo deleted, local modified) deletes local — does NOT ENOENT", async () => {
    // Setup: file exists locally (modified vs state), no repo file (deleted).
    writeFileSync(join(LOCAL, "x.md"), "local-edit");
    const change: FileChange = {
      relativePath: "x.md", rootName: "claude", action: "conflict", side: "both",
      localHash: hashContent("local-edit"),
      repoHash: undefined,
      stateHash: hashContent("original"),
    };
    const initial = emptyState();
    initial.files["claude/x.md"] = { hash: hashContent("original"), size: 8, syncedAt: "now" };

    const { resolved, exec } = await applyThroughBulk(change, "1", initial);

    assert.equal(resolved, "delete-local",
      "repo-wins on a repo-deleted conflict must propagate the deletion");
    assert.equal(existsSync(join(LOCAL, "x.md")), false, "local file should be removed");
    assert.equal(exec.state.files["claude/x.md"], undefined, "state entry should be cleared");
    // No FAIL line in the log — the bug surfaced as `FAIL ... ENOENT`.
    for (const line of exec.log) {
      assert.equal(line.startsWith("FAIL"), false, `unexpected FAIL: ${line}`);
    }
  });

  it("local-wins on (local deleted, repo modified) deletes repo — does NOT ENOENT", async () => {
    // Setup: no local file (deleted), repo file exists (modified vs state).
    mkdirSync(join(REPO, "claude"), { recursive: true });
    writeFileSync(join(REPO, "claude", "y.md"), "repo-edit");
    const change: FileChange = {
      relativePath: "y.md", rootName: "claude", action: "conflict", side: "both",
      localHash: undefined,
      repoHash: hashContent("repo-edit"),
      stateHash: hashContent("original"),
    };
    const initial = emptyState();
    initial.files["claude/y.md"] = { hash: hashContent("original"), size: 8, syncedAt: "now" };

    const { resolved, exec } = await applyThroughBulk(change, "2", initial);

    assert.equal(resolved, "delete-repo",
      "local-wins on a local-deleted conflict must propagate the deletion");
    assert.equal(existsSync(join(REPO, "claude", "y.md")), false, "repo file should be removed");
    assert.deepEqual(exec.gitPaths, [join("claude", "y.md")], "deletion must be staged");
    assert.equal(exec.state.files["claude/y.md"], undefined);
    for (const line of exec.log) {
      assert.equal(line.startsWith("FAIL"), false, `unexpected FAIL: ${line}`);
    }
  });

  it("repo-wins on (local deleted, repo modified) restores local file", async () => {
    // The "well-behaved" half of the same conflict shape: repo-wins on a
    // local-deleted conflict copies the surviving repo file back to local.
    mkdirSync(join(REPO, "claude"), { recursive: true });
    writeFileSync(join(REPO, "claude", "z.md"), "repo-content");
    const change: FileChange = {
      relativePath: "z.md", rootName: "claude", action: "conflict", side: "both",
      localHash: undefined,
      repoHash: hashContent("repo-content"),
      stateHash: hashContent("original"),
    };
    const initial = emptyState();
    initial.files["claude/z.md"] = { hash: hashContent("original"), size: 8, syncedAt: "now" };

    const { resolved, exec } = await applyThroughBulk(change, "1", initial);

    assert.equal(resolved, "keep-repo");
    assert.equal(readFileSync(join(LOCAL, "z.md"), "utf-8"), "repo-content");
    assert.equal(exec.state.files["claude/z.md"].hash, hashContent("repo-content"));
  });

  it("local-wins on (repo deleted, local modified) restores repo file", async () => {
    writeFileSync(join(LOCAL, "w.md"), "local-content");
    const change: FileChange = {
      relativePath: "w.md", rootName: "claude", action: "conflict", side: "both",
      localHash: hashContent("local-content"),
      repoHash: undefined,
      stateHash: hashContent("original"),
    };
    const initial = emptyState();
    initial.files["claude/w.md"] = { hash: hashContent("original"), size: 8, syncedAt: "now" };

    const { resolved, exec } = await applyThroughBulk(change, "2", initial);

    assert.equal(resolved, "keep-local");
    assert.equal(readFileSync(join(REPO, "claude", "w.md"), "utf-8"), "local-content");
    assert.deepEqual(exec.gitPaths, [join("claude", "w.md")]);
  });
});
