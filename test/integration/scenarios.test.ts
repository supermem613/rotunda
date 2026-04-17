import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadManifest } from "../../src/core/manifest.js";
import { loadState, saveState, emptyState, updateStateFiles, removeFromState } from "../../src/core/state.js";
import { computeAllChanges, discoverFiles, hashFiles } from "../../src/core/engine.js";
import type { SyncState, FileChange } from "../../src/core/types.js";

// ── Temp directory layout ────────────────────────────────────────────
const TMP = join(import.meta.dirname, "__scenarios_tmp__");
const REPO = join(TMP, "repo");
const LOCAL = join(TMP, "local");
const REPO_ROOT = join(REPO, "config");

// ── Helpers ──────────────────────────────────────────────────────────

function resetDirs() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(LOCAL, { recursive: true });
  mkdirSync(REPO_ROOT, { recursive: true });
}

function cleanup() {
  rmSync(TMP, { recursive: true, force: true });
}

function writeManifest(
  roots?: Array<{
    name: string;
    local: string;
    repo: string;
    include?: string[];
    exclude?: string[];
  }>,
  globalExclude: string[] = ["node_modules", ".git"],
) {
  const manifest = {
    version: 1,
    roots: (roots ?? [{ name: "config", local: LOCAL, repo: "config" }]).map(
      (r) => ({
        name: r.name,
        local: r.local,
        repo: r.repo,
        include: r.include ?? [],
        exclude: r.exclude ?? [],
      }),
    ),
    globalExclude,
  };
  writeFileSync(join(REPO, "rotunda.json"), JSON.stringify(manifest));
}

/** Build a SyncState from all discoverable files in a directory. */
async function stateFromDir(
  dir: string,
  rootRepo: string,
  include: string[] = [],
  exclude: string[] = [],
  globalExclude: string[] = ["node_modules", ".git"],
): Promise<SyncState> {
  const files = await discoverFiles(dir, include, exclude, globalExclude);
  const hashes = await hashFiles(files);
  return updateStateFiles(emptyState(), rootRepo, hashes);
}

/** Merge multiple SyncStates into one (combines file records). */
function mergeStates(...states: SyncState[]): SyncState {
  const merged = emptyState();
  for (const s of states) {
    Object.assign(merged.files, s.files);
  }
  return merged;
}

/** Find a change by relativePath. */
function findChange(
  changes: FileChange[],
  relativePath: string,
): FileChange | undefined {
  return changes.find((c) => c.relativePath === relativePath);
}

// ── Scenario 1: basic-push ──────────────────────────────────────────

describe("Scenario 1: basic-push", () => {
  beforeEach(resetDirs);
  afterEach(cleanup);

  it("file added locally, not in repo → added/local", async () => {
    writeFileSync(join(LOCAL, "hello.txt"), "hello world");
    writeManifest();

    const manifest = loadManifest(REPO);
    const changes = await computeAllChanges(manifest, REPO, emptyState());

    assert.equal(changes.length, 1);
    const c = changes[0];
    assert.equal(c.relativePath, "hello.txt");
    assert.equal(c.action, "added");
    assert.equal(c.side, "local");
    assert.equal(c.rootName, "config");
    assert.ok(c.localHash, "localHash should be set");
    assert.equal(c.repoHash, undefined, "repoHash should be undefined");
  });
});

// ── Scenario 2: basic-pull ──────────────────────────────────────────

describe("Scenario 2: basic-pull", () => {
  beforeEach(resetDirs);
  afterEach(cleanup);

  it("file added in repo, not locally → added/repo", async () => {
    writeFileSync(join(REPO_ROOT, "remote.txt"), "from repo");
    writeManifest();

    const manifest = loadManifest(REPO);
    const changes = await computeAllChanges(manifest, REPO, emptyState());

    assert.equal(changes.length, 1);
    const c = changes[0];
    assert.equal(c.relativePath, "remote.txt");
    assert.equal(c.action, "added");
    assert.equal(c.side, "repo");
    assert.equal(c.rootName, "config");
    assert.equal(c.localHash, undefined, "localHash should be undefined");
    assert.ok(c.repoHash, "repoHash should be set");
  });
});

// ── Scenario 3: deletion-push ───────────────────────────────────────

describe("Scenario 3: deletion-push", () => {
  beforeEach(resetDirs);
  afterEach(cleanup);

  it("file in state+repo, deleted locally → deleted/local", async () => {
    // File exists in repo (unchanged since last sync)
    writeFileSync(join(REPO_ROOT, "old.txt"), "original content");
    writeManifest();

    // State records the file with a hash matching the repo version
    const state = await stateFromDir(REPO_ROOT, "config");

    // Local does NOT have the file — it was deleted locally
    const manifest = loadManifest(REPO);
    const changes = await computeAllChanges(manifest, REPO, state);

    assert.equal(changes.length, 1);
    const c = changes[0];
    assert.equal(c.relativePath, "old.txt");
    assert.equal(c.action, "deleted");
    assert.equal(c.side, "local");
    assert.equal(c.localHash, undefined, "localHash should be undefined (file deleted)");
    assert.ok(c.repoHash, "repoHash should still be set");
    assert.ok(c.stateHash, "stateHash should be set");
  });
});

// ── Scenario 4: deletion-pull ───────────────────────────────────────

describe("Scenario 4: deletion-pull", () => {
  beforeEach(resetDirs);
  afterEach(cleanup);

  it("file in state+local, removed from repo → deleted/repo", async () => {
    // File exists locally (unchanged since last sync)
    writeFileSync(join(LOCAL, "removed.txt"), "was here");
    writeManifest();

    // State records the file with a hash matching the local version
    const state = await stateFromDir(LOCAL, "config");

    // Repo does NOT have the file — it was removed from repo
    const manifest = loadManifest(REPO);
    const changes = await computeAllChanges(manifest, REPO, state);

    assert.equal(changes.length, 1);
    const c = changes[0];
    assert.equal(c.relativePath, "removed.txt");
    assert.equal(c.action, "deleted");
    assert.equal(c.side, "repo");
    assert.ok(c.localHash, "localHash should still be set");
    assert.equal(c.repoHash, undefined, "repoHash should be undefined (file removed)");
    assert.ok(c.stateHash, "stateHash should be set");
  });
});

// ── Scenario 5: conflict-both-modified ──────────────────────────────

describe("Scenario 5: conflict-both-modified", () => {
  beforeEach(resetDirs);
  afterEach(cleanup);

  it("file modified on both sides since last sync → conflict/both", async () => {
    // Write identical original content to both sides
    writeFileSync(join(LOCAL, "shared.txt"), "original");
    writeFileSync(join(REPO_ROOT, "shared.txt"), "original");
    writeManifest();

    // Build state from original content (hashes match both sides)
    const state = await stateFromDir(LOCAL, "config");

    // Modify both sides with different content
    writeFileSync(join(LOCAL, "shared.txt"), "local edit v2");
    writeFileSync(join(REPO_ROOT, "shared.txt"), "repo edit v2");

    const manifest = loadManifest(REPO);
    const changes = await computeAllChanges(manifest, REPO, state);

    assert.equal(changes.length, 1);
    const c = changes[0];
    assert.equal(c.relativePath, "shared.txt");
    assert.equal(c.action, "conflict");
    assert.equal(c.side, "both");
    assert.ok(c.localHash, "localHash should be set");
    assert.ok(c.repoHash, "repoHash should be set");
    assert.ok(c.stateHash, "stateHash should be set");
    assert.notEqual(c.localHash, c.repoHash, "local and repo hashes should differ");
    assert.notEqual(c.localHash, c.stateHash, "local hash should differ from state");
    assert.notEqual(c.repoHash, c.stateHash, "repo hash should differ from state");
  });
});

// ── Scenario 6: new-skill-added ─────────────────────────────────────

describe("Scenario 6: new-skill-added", () => {
  beforeEach(resetDirs);
  afterEach(cleanup);

  it("multiple files in new subdirectory added locally → all added/local", async () => {
    mkdirSync(join(LOCAL, "myskill"), { recursive: true });
    writeFileSync(join(LOCAL, "myskill", "SKILL.md"), "# My Skill");
    writeFileSync(join(LOCAL, "myskill", "prompt.txt"), "Do the thing");
    writeFileSync(join(LOCAL, "myskill", "config.json"), '{"enabled": true}');
    writeManifest();

    const manifest = loadManifest(REPO);
    const changes = await computeAllChanges(manifest, REPO, emptyState());

    assert.equal(changes.length, 3);
    for (const c of changes) {
      assert.equal(c.action, "added", `${c.relativePath} should be added`);
      assert.equal(c.side, "local", `${c.relativePath} should be local`);
      assert.equal(c.rootName, "config");
    }

    const paths = changes.map((c) => c.relativePath).sort();
    assert.deepEqual(paths, [
      "myskill/SKILL.md",
      "myskill/config.json",
      "myskill/prompt.txt",
    ]);
  });
});

// ── Scenario 7: skill-removed ───────────────────────────────────────

describe("Scenario 7: skill-removed", () => {
  beforeEach(resetDirs);
  afterEach(cleanup);

  it("entire subdirectory removed from repo → all files deleted/repo", async () => {
    // Files exist locally (unchanged since last sync)
    mkdirSync(join(LOCAL, "oldskill"), { recursive: true });
    writeFileSync(join(LOCAL, "oldskill", "SKILL.md"), "# Old Skill");
    writeFileSync(join(LOCAL, "oldskill", "prompt.txt"), "legacy prompt");
    writeManifest();

    // State records these files with hashes matching local
    const state = await stateFromDir(LOCAL, "config");

    // Repo does NOT have the oldskill directory (it was removed)
    const manifest = loadManifest(REPO);
    const changes = await computeAllChanges(manifest, REPO, state);

    assert.equal(changes.length, 2);
    for (const c of changes) {
      assert.equal(c.action, "deleted", `${c.relativePath} should be deleted`);
      assert.equal(c.side, "repo", `${c.relativePath} should be repo-side`);
    }

    const paths = changes.map((c) => c.relativePath).sort();
    assert.deepEqual(paths, ["oldskill/SKILL.md", "oldskill/prompt.txt"]);
  });
});

// ── Scenario 8: ignore-node-modules ─────────────────────────────────

describe("Scenario 8: ignore-node-modules", () => {
  beforeEach(resetDirs);
  afterEach(cleanup);

  it("files inside node_modules are never included in changes", async () => {
    // Real files
    writeFileSync(join(LOCAL, "real.txt"), "real file");
    mkdirSync(join(LOCAL, "sub"), { recursive: true });
    writeFileSync(join(LOCAL, "sub", "legit.txt"), "legit");

    // node_modules at root level
    mkdirSync(join(LOCAL, "node_modules"), { recursive: true });
    writeFileSync(join(LOCAL, "node_modules", "dep.js"), "module.exports = {}");

    // node_modules nested inside a subdirectory
    mkdirSync(join(LOCAL, "sub", "node_modules"), { recursive: true });
    writeFileSync(join(LOCAL, "sub", "node_modules", "nested.js"), "nested dep");

    writeManifest();

    const manifest = loadManifest(REPO);
    const changes = await computeAllChanges(manifest, REPO, emptyState());

    assert.equal(changes.length, 2, "Only non-node_modules files should appear");
    assert.ok(
      !changes.some((c) => c.relativePath.includes("node_modules")),
      "No node_modules files should appear in changes",
    );

    const paths = changes.map((c) => c.relativePath).sort();
    assert.deepEqual(paths, ["real.txt", "sub/legit.txt"]);
  });
});

// ── Scenario 9: empty-state-first-sync ──────────────────────────────

describe("Scenario 9: empty-state-first-sync", () => {
  beforeEach(resetDirs);
  afterEach(cleanup);

  it("no changes when both sides have identical content and no state", async () => {
    // Identical files on both sides
    writeFileSync(join(LOCAL, "synced.txt"), "identical content");
    writeFileSync(join(REPO_ROOT, "synced.txt"), "identical content");

    mkdirSync(join(LOCAL, "sub"), { recursive: true });
    mkdirSync(join(REPO_ROOT, "sub"), { recursive: true });
    writeFileSync(join(LOCAL, "sub", "also-same.txt"), "also the same");
    writeFileSync(join(REPO_ROOT, "sub", "also-same.txt"), "also the same");

    writeManifest();

    const manifest = loadManifest(REPO);
    const changes = await computeAllChanges(manifest, REPO, emptyState());

    assert.equal(
      changes.length,
      0,
      "Identical files on both sides with no state should produce zero changes",
    );
  });
});

// ── Scenario 10: mixed-changes ──────────────────────────────────────

describe("Scenario 10: mixed-changes", () => {
  const localAlpha = join(LOCAL, "alpha");
  const localBeta = join(LOCAL, "beta");
  const repoAlpha = join(REPO, "alpha");
  const repoBeta = join(REPO, "beta");

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(localAlpha, { recursive: true });
    mkdirSync(localBeta, { recursive: true });
    mkdirSync(repoAlpha, { recursive: true });
    mkdirSync(repoBeta, { recursive: true });
  });
  afterEach(cleanup);

  it("multiple change types across multiple roots", async () => {
    // ── Phase 1: baseline files (captured in state) ──
    // alpha root: files that will be modified and left unchanged
    writeFileSync(join(localAlpha, "modified-local.txt"), "original alpha");
    writeFileSync(join(repoAlpha, "modified-local.txt"), "original alpha");
    writeFileSync(join(localAlpha, "unchanged.txt"), "same alpha");
    writeFileSync(join(repoAlpha, "unchanged.txt"), "same alpha");

    // beta root: file that will be deleted from repo
    writeFileSync(join(localBeta, "deleted-repo.txt"), "beta content");
    writeFileSync(join(repoBeta, "deleted-repo.txt"), "beta content");

    writeManifest([
      { name: "alpha", local: localAlpha, repo: "alpha" },
      { name: "beta", local: localBeta, repo: "beta" },
    ]);

    // ── Phase 2: build state from baseline ──
    const stateAlpha = await stateFromDir(localAlpha, "alpha");
    const stateBeta = await stateFromDir(localBeta, "beta");
    const state = mergeStates(stateAlpha, stateBeta);

    // ── Phase 3: apply changes ──
    // alpha: modify one file locally
    writeFileSync(join(localAlpha, "modified-local.txt"), "edited locally");
    // alpha: new file added only to local
    writeFileSync(join(localAlpha, "added-local.txt"), "brand new local");
    // alpha: new file added only to repo
    writeFileSync(join(repoAlpha, "added-repo.txt"), "brand new repo");
    // beta: remove file from repo
    rmSync(join(repoBeta, "deleted-repo.txt"));

    // ── Phase 4: compute changes ──
    const manifest = loadManifest(REPO);
    const changes = await computeAllChanges(manifest, REPO, state);

    // ── Phase 5: assertions ──
    assert.equal(
      changes.length,
      4,
      `Expected 4 changes, got: ${JSON.stringify(changes.map((c) => `${c.rootName}:${c.relativePath} → ${c.action}/${c.side}`))}`,
    );

    // Verify unchanged.txt is NOT in changes
    assert.ok(
      !changes.some((c) => c.relativePath === "unchanged.txt"),
      "unchanged.txt should not appear in changes",
    );

    // Split by root
    const alphaChanges = changes.filter((c) => c.rootName === "alpha");
    const betaChanges = changes.filter((c) => c.rootName === "beta");
    assert.equal(alphaChanges.length, 3, "alpha should have 3 changes");
    assert.equal(betaChanges.length, 1, "beta should have 1 change");

    // alpha: added-local.txt → added/local
    const addedLocal = findChange(alphaChanges, "added-local.txt");
    assert.ok(addedLocal, "Should find added-local.txt");
    assert.equal(addedLocal.action, "added");
    assert.equal(addedLocal.side, "local");

    // alpha: added-repo.txt → added/repo
    const addedRepo = findChange(alphaChanges, "added-repo.txt");
    assert.ok(addedRepo, "Should find added-repo.txt");
    assert.equal(addedRepo.action, "added");
    assert.equal(addedRepo.side, "repo");

    // alpha: modified-local.txt → modified/local
    const modifiedLocal = findChange(alphaChanges, "modified-local.txt");
    assert.ok(modifiedLocal, "Should find modified-local.txt");
    assert.equal(modifiedLocal.action, "modified");
    assert.equal(modifiedLocal.side, "local");

    // beta: deleted-repo.txt → deleted/repo
    const deletedRepo = findChange(betaChanges, "deleted-repo.txt");
    assert.ok(deletedRepo, "Should find deleted-repo.txt");
    assert.equal(deletedRepo.action, "deleted");
    assert.equal(deletedRepo.side, "repo");
  });
});
