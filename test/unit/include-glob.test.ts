import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyTrackingPlan,
  planTrackingPathChange,
  resolveTrackingTarget,
  suggestNewRootName,
} from "../../src/core/include-glob.js";
import { loadManifest, loadManifestDocument, RotundaError } from "../../src/core/manifest.js";
import { emptyState, loadState, updateStateFiles } from "../../src/core/state.js";

const TMP = join(tmpdir(), "rotunda-include-glob-test");
const REPO = join(TMP, "repo");
const LOCAL = join(TMP, "local");
const OTHER = join(TMP, "other");
const REPO_CLAUDE = join(REPO, ".claude");

function resetDirs(): void {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(LOCAL, { recursive: true });
  mkdirSync(OTHER, { recursive: true });
  mkdirSync(REPO_CLAUDE, { recursive: true });
  mkdirSync(join(REPO, ".rotunda"), { recursive: true });
}

function cleanup(): void {
  rmSync(TMP, { recursive: true, force: true });
}

function writeManifest(roots: Array<{
  name: string;
  local: string;
  repo: string;
  include: string[];
  exclude?: string[];
}>): void {
  writeFileSync(
    join(REPO, "rotunda.json"),
    JSON.stringify({
      version: 1,
      roots: roots.map((root) => ({
        ...root,
        exclude: root.exclude ?? [],
      })),
      globalExclude: [".git"],
    }, null, 2) + "\n",
  );
}

async function plan(
  kind: "add" | "remove",
  path: string,
  state = emptyState(),
  newRootName?: string,
) {
  const target = await resolveTrackingTarget(path, TMP);
  return planTrackingPathChange(
    REPO,
    loadManifest(REPO),
    loadManifestDocument(REPO),
    state,
    target,
    kind,
    newRootName,
  );
}

describe("resolveTrackingTarget", () => {
  beforeEach(resetDirs);
  afterEach(cleanup);

  it("detects files and directories from relative input", async () => {
    mkdirSync(join(LOCAL, "skills"), { recursive: true });
    writeFileSync(join(LOCAL, "skills", "commit.md"), "# Commit");

    const fileTarget = await resolveTrackingTarget("local/skills/commit.md", TMP);
    const dirTarget = await resolveTrackingTarget("local/skills", TMP);

    assert.equal(fileTarget.kind, "file");
    assert.equal(dirTarget.kind, "directory");
  });

  it("throws on missing paths", async () => {
    await assert.rejects(
      () => resolveTrackingTarget("missing/file.txt", TMP),
      (err: unknown) => err instanceof RotundaError && err.message.includes("Path does not exist"),
    );
  });
});

describe("planTrackingPathChange", () => {
  beforeEach(resetDirs);
  afterEach(cleanup);

  it("adds a single file under an existing root", async () => {
    writeManifest([{ name: "claude", local: LOCAL, repo: ".claude", include: ["CLAUDE.md"] }]);
    mkdirSync(join(LOCAL, "skills"), { recursive: true });
    writeFileSync(join(LOCAL, "skills", "commit.md"), "# Commit");

    const result = await plan("add", join(LOCAL, "skills", "commit.md"));

    assert.equal(result.manifestMutation.kind, "add-include");
    assert.equal(result.manifestMutation.pattern, "skills/commit.md");
    assert.ok(result.nextManifest.roots[0].include.includes("skills/commit.md"));
    assert.equal(result.repoCopies[0].status, "create");
  });

  it("creates a new root for an unmatched path when given a root name", async () => {
    writeManifest([{ name: "claude", local: LOCAL, repo: ".claude", include: ["CLAUDE.md"] }]);
    writeFileSync(join(OTHER, "settings.json"), "{\"theme\":\"dark\"}");

    const result = await plan("add", join(OTHER, "settings.json"), emptyState(), "othercfg");

    assert.equal(result.manifestMutation.kind, "create-root");
    assert.equal(result.rootName, "othercfg");
    const createdRoot = result.nextManifest.roots.find((root) => root.name === "othercfg");
    assert.ok(createdRoot);
    assert.equal(createdRoot!.repo, "other");
    assert.deepEqual(createdRoot!.include, ["settings.json"]);
  });

  it("removes an exact include when it safely untracks a file", async () => {
    writeManifest([{
      name: "claude",
      local: LOCAL,
      repo: ".claude",
      include: ["CLAUDE.md", "settings.json"],
    }]);
    writeFileSync(join(LOCAL, "CLAUDE.md"), "# Claude");
    writeFileSync(join(LOCAL, "settings.json"), "{}");
    writeFileSync(join(REPO_CLAUDE, "settings.json"), "{}");

    const result = await plan("remove", join(LOCAL, "settings.json"));

    assert.equal(result.manifestMutation.kind, "remove-include");
    assert.ok(!result.nextManifest.roots[0].include.includes("settings.json"));
  });

  it("adds an exclude when removing a path covered by a broader include", async () => {
    writeManifest([{
      name: "claude",
      local: LOCAL,
      repo: ".claude",
      include: ["CLAUDE.md", "skills/**"],
    }]);
    mkdirSync(join(LOCAL, "skills", "kept"), { recursive: true });
    mkdirSync(join(REPO_CLAUDE, "skills", "kept"), { recursive: true });
    writeFileSync(join(LOCAL, "skills", "kept", "SKILL.md"), "# local");
    writeFileSync(join(REPO_CLAUDE, "skills", "kept", "SKILL.md"), "# repo");
    const state = updateStateFiles(
      emptyState(),
      ".claude",
      new Map([["skills/kept/SKILL.md", "hash-kept"]]),
    );

    const result = await plan("remove", join(LOCAL, "skills", "kept"), state);

    assert.equal(result.manifestMutation.kind, "add-exclude");
    assert.ok(result.nextManifest.roots[0].include.includes("skills/**"));
    assert.ok(result.nextManifest.roots[0].exclude.includes("skills/kept/**"));
    assert.deepEqual(result.repoDeletes.map((entry) => entry.relativePath), ["skills/kept/SKILL.md"]);
  });

  it("removes the whole root when the target path is the root directory", async () => {
    writeManifest([{
      name: "claude",
      local: LOCAL,
      repo: ".claude",
      include: ["**"],
    }]);
    writeFileSync(join(LOCAL, "CLAUDE.md"), "# Claude");
    writeFileSync(join(REPO_CLAUDE, "CLAUDE.md"), "# Claude");
    const state = updateStateFiles(emptyState(), ".claude", new Map([["CLAUDE.md", "hash"]]));

    const result = await plan("remove", LOCAL, state);

    assert.equal(result.manifestMutation.kind, "remove-root");
    assert.equal(result.nextManifest.roots.length, 0);
    assert.deepEqual(result.repoDeletes.map((entry) => entry.relativePath), ["CLAUDE.md"]);
    assert.deepEqual(result.stateRemovals, ["CLAUDE.md"]);
  });

  it("rejects add when the target is already tracked", async () => {
    writeManifest([{ name: "claude", local: LOCAL, repo: ".claude", include: ["CLAUDE.md"] }]);
    writeFileSync(join(LOCAL, "CLAUDE.md"), "# Claude");
    writeFileSync(join(REPO_CLAUDE, "CLAUDE.md"), "# Claude");

    await assert.rejects(
      () => plan("add", join(LOCAL, "CLAUDE.md")),
      (err: unknown) => err instanceof RotundaError && err.message.includes("already fully tracked"),
    );
  });

  it("suggests a readable default name for a new root", () => {
    assert.equal(
      suggestNewRootName({
        inputPath: join(OTHER, "settings.json"),
        absolutePath: join(OTHER, "settings.json"),
        kind: "file",
      }),
      "other",
    );
  });
});

describe("applyTrackingPlan", () => {
  beforeEach(resetDirs);
  afterEach(cleanup);

  it("writes a created root, copies files, and updates state", async () => {
    writeManifest([{ name: "claude", local: LOCAL, repo: ".claude", include: ["CLAUDE.md"] }]);
    writeFileSync(join(OTHER, "settings.json"), "{\"theme\":\"dark\"}");

    const result = await plan("add", join(OTHER, "settings.json"), emptyState(), "othercfg");
    await applyTrackingPlan(REPO, result, emptyState());

    const manifestDoc = loadManifestDocument(REPO);
    const createdRoot = manifestDoc.roots.find((root) => root.name === "othercfg");
    assert.ok(createdRoot);
    assert.equal(
      readFileSync(join(REPO, "other", "settings.json"), "utf-8"),
      "{\"theme\":\"dark\"}",
    );

    const state = await loadState(REPO);
    assert.ok(state.files["other/settings.json"]);
  });
});
