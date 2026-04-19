import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync, writeFileSync, readFileSync, rmSync, existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadManifest } from "../../src/core/manifest.js";
import { loadState, saveState, emptyState } from "../../src/core/state.js";
import { computeAllChanges, discoverFiles, hashFiles } from "../../src/core/engine.js";
import { updateStateFiles, removeFromState } from "../../src/core/state.js";

const TMP = join(tmpdir(), "rotunda-pushpull-test");
const REPO = join(TMP, "repo");
const LOCAL = join(TMP, "local");

function setup() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(REPO, ".claude", "skills", "commit"), { recursive: true });
  mkdirSync(join(LOCAL, ".claude", "skills", "commit"), { recursive: true });
  mkdirSync(join(REPO, ".rotunda"), { recursive: true });

  // Create manifest in repo
  writeFileSync(
    join(REPO, "rotunda.json"),
    JSON.stringify({
      version: 1,
      roots: [
        {
          name: "claude",
          local: LOCAL + "/.claude",
          repo: ".claude",
          include: ["skills/**", "CLAUDE.md"],
          exclude: ["node_modules"],
        },
      ],
      globalExclude: ["node_modules", ".git"],
    }),
  );
}

function cleanup() {
  rmSync(TMP, { recursive: true, force: true });
}

describe("Integration: push flow", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("detects locally added file as pushable", async () => {
    // File exists locally but not in repo
    writeFileSync(join(LOCAL, ".claude", "skills", "commit", "SKILL.md"), "# Commit Skill");

    const manifest = loadManifest(REPO);
    const state = emptyState();
    const changes = await computeAllChanges(manifest, REPO, state);

    const added = changes.filter((c) => c.action === "added" && c.side === "local");
    assert.ok(added.length > 0, "Should detect locally added file");
    assert.ok(
      added.some((c) => c.relativePath === "skills/commit/SKILL.md"),
      "Should find the SKILL.md file",
    );
  });

  it("detects locally modified file", async () => {
    // Same file in both, but different content
    writeFileSync(join(LOCAL, ".claude", "skills", "commit", "SKILL.md"), "# Modified");
    writeFileSync(join(REPO, ".claude", "skills", "commit", "SKILL.md"), "# Original");

    const manifest = loadManifest(REPO);

    // Create state where the file was synced with the repo version
    const repoFiles = await discoverFiles(
      join(REPO, ".claude"),
      manifest.roots[0].include,
      manifest.roots[0].exclude,
      manifest.globalExclude,
    );
    const repoHashes = await hashFiles(repoFiles);
    let state = emptyState();
    state = updateStateFiles(state, ".claude", repoHashes);

    const changes = await computeAllChanges(manifest, REPO, state);
    const modified = changes.filter((c) => c.action === "modified" && c.side === "local");
    assert.ok(modified.length > 0, "Should detect locally modified file");
  });

  it("ignores node_modules", async () => {
    mkdirSync(join(LOCAL, ".claude", "skills", "commit", "node_modules"), { recursive: true });
    writeFileSync(
      join(LOCAL, ".claude", "skills", "commit", "node_modules", "pkg.js"),
      "module.exports = {}",
    );
    writeFileSync(join(LOCAL, ".claude", "skills", "commit", "SKILL.md"), "# Skill");

    const manifest = loadManifest(REPO);
    const state = emptyState();
    const changes = await computeAllChanges(manifest, REPO, state);

    assert.ok(
      !changes.some((c) => c.relativePath.includes("node_modules")),
      "Should not include node_modules files",
    );
    assert.ok(
      changes.some((c) => c.relativePath === "skills/commit/SKILL.md"),
      "Should include SKILL.md",
    );
  });
});

describe("Integration: pull flow (orphan cleanup)", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("detects repo-deleted file for local cleanup", async () => {
    // File exists locally but was removed from repo
    writeFileSync(join(LOCAL, ".claude", "skills", "commit", "SKILL.md"), "# Old Skill");

    const manifest = loadManifest(REPO);

    // State says the file existed at last sync
    let state = emptyState();
    const localFiles = await discoverFiles(
      join(LOCAL, ".claude"),
      manifest.roots[0].include,
      manifest.roots[0].exclude,
      manifest.globalExclude,
    );
    const localHashes = await hashFiles(localFiles);
    state = updateStateFiles(state, ".claude", localHashes);

    // Now compute changes — file is in state + local but not in repo → deleted in repo
    const changes = await computeAllChanges(manifest, REPO, state);
    const deleted = changes.filter((c) => c.action === "deleted" && c.side === "repo");
    assert.ok(deleted.length > 0, "Should detect file deleted from repo for local cleanup");
  });
});

describe("Integration: conflict detection", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("detects conflict when both sides modified", async () => {
    writeFileSync(join(LOCAL, ".claude", "skills", "commit", "SKILL.md"), "# Local version");
    writeFileSync(join(REPO, ".claude", "skills", "commit", "SKILL.md"), "# Repo version");

    const manifest = loadManifest(REPO);

    // State has the original version
    let state = emptyState();
    state.files[".claude/skills/commit/SKILL.md"] = {
      hash: "original-hash-different-from-both",
      size: 0,
      syncedAt: new Date().toISOString(),
    };

    const changes = await computeAllChanges(manifest, REPO, state);
    const conflicts = changes.filter((c) => c.action === "conflict");
    assert.ok(conflicts.length > 0, "Should detect conflict");
  });
});

describe("Integration: state management", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("persists and loads state", async () => {
    let state = emptyState();
    state = updateStateFiles(state, ".claude", new Map([["test.md", "hash123"]]));

    await saveState(REPO, state);
    const loaded = await loadState(REPO);

    assert.equal(loaded.files[".claude/test.md"].hash, "hash123");
  });

  it("handles missing state file gracefully", async () => {
    const loaded = await loadState(join(TMP, "nonexistent"));
    assert.deepEqual(loaded.files, {});
  });
});

describe("Integration: machine overrides", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("excludes files on matching machine, includes on others", async () => {
    mkdirSync(join(LOCAL, ".claude", "skills", "general"), { recursive: true });
    mkdirSync(join(LOCAL, ".claude", "skills", "odsp-web"), { recursive: true });
    writeFileSync(join(LOCAL, ".claude", "skills", "general", "SKILL.md"), "# General");
    writeFileSync(join(LOCAL, ".claude", "skills", "odsp-web", "SKILL.md"), "# Work only");

    writeFileSync(
      join(REPO, "rotunda.json"),
      JSON.stringify({
        version: 1,
        roots: [
          {
            name: "claude",
            local: LOCAL + "/.claude",
            repo: ".claude",
            include: ["skills/**"],
            exclude: ["node_modules"],
          },
        ],
        globalExclude: [],
        machineOverrides: {
          "wisp": {
            roots: {
              "claude": { exclude: ["skills/odsp-web/**"] },
            },
          },
        },
      }),
    );

    // On wisp: odsp-web excluded
    const manifestWisp = loadManifest(REPO, "wisp");
    const changesWisp = await computeAllChanges(manifestWisp, REPO, emptyState());
    assert.ok(
      changesWisp.some((c) => c.relativePath === "skills/general/SKILL.md"),
      "General skill included on wisp",
    );
    assert.ok(
      !changesWisp.some((c) => c.relativePath.includes("odsp-web")),
      "odsp-web excluded on wisp",
    );

    // On captain: both included
    const manifestCaptain = loadManifest(REPO, "captain");
    const changesCaptain = await computeAllChanges(manifestCaptain, REPO, emptyState());
    assert.ok(
      changesCaptain.some((c) => c.relativePath === "skills/general/SKILL.md"),
      "General skill included on captain",
    );
    assert.ok(
      changesCaptain.some((c) => c.relativePath === "skills/odsp-web/SKILL.md"),
      "odsp-web included on captain",
    );
  });
});
