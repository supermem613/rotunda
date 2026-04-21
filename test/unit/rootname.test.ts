import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync, writeFileSync, rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadManifest } from "../../src/core/manifest.js";
import { emptyState, updateStateFiles } from "../../src/core/state.js";
import { computeAllChanges, computeChanges, discoverFiles, hashFiles } from "../../src/core/engine.js";
import type { Manifest } from "../../src/core/types.js";

const TMP = join(tmpdir(), "rotunda-rootname-test");
const REPO = join(TMP, "repo");
const LOCAL = join(TMP, "local");

function setup() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(REPO, ".claude", "skills"), { recursive: true });
  mkdirSync(join(LOCAL, ".claude", "skills"), { recursive: true });
  mkdirSync(join(REPO, ".copilot", "agents"), { recursive: true });
  mkdirSync(join(LOCAL, ".copilot", "agents"), { recursive: true });
  mkdirSync(join(REPO, ".rotunda"), { recursive: true });

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
        {
          name: "copilot",
          local: LOCAL + "/.copilot",
          repo: ".copilot",
          include: ["agents/**"],
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

describe("rootName uses repo path for display and lookup", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("computeAllChanges sets rootName to root.repo, not root.name", async () => {
    writeFileSync(join(LOCAL, ".claude", "skills", "SKILL.md"), "# Skill");
    writeFileSync(join(LOCAL, ".copilot", "agents", "agent.md"), "# Agent");

    const manifest = loadManifest(REPO);
    const changes = await computeAllChanges(manifest, REPO, emptyState());

    const claudeChange = changes.find((c) => c.relativePath === "skills/SKILL.md");
    const copilotChange = changes.find((c) => c.relativePath === "agents/agent.md");

    assert.ok(claudeChange, "Should detect claude file");
    assert.ok(copilotChange, "Should detect copilot file");

    // rootName must be the repo path (e.g., ".claude"), not the name (e.g., "claude")
    assert.equal(claudeChange.rootName, ".claude",
      "rootName should be '.claude' (repo path), not 'claude' (name)");
    assert.equal(copilotChange.rootName, ".copilot",
      "rootName should be '.copilot' (repo path), not 'copilot' (name)");
  });

  it("rootName can be used to find the root definition in the manifest", async () => {
    writeFileSync(join(LOCAL, ".claude", "skills", "SKILL.md"), "# Skill");
    writeFileSync(join(LOCAL, ".copilot", "agents", "agent.md"), "# Agent");

    const manifest = loadManifest(REPO);
    const changes = await computeAllChanges(manifest, REPO, emptyState());

    // Every change's rootName must resolve to a root definition
    for (const change of changes) {
      const rootDef = manifest.roots.find((r) => r.repo === change.rootName);
      assert.ok(rootDef,
        `rootName '${change.rootName}' must match a root's repo field in the manifest`);
    }
  });

  it("rootName matches state key prefix for state updates", async () => {
    writeFileSync(join(LOCAL, ".claude", "skills", "SKILL.md"), "# Skill");
    writeFileSync(join(REPO, ".claude", "skills", "SKILL.md"), "# Skill");

    const manifest = loadManifest(REPO);

    // Sync the file into state
    const repoFiles = await discoverFiles(
      join(REPO, ".claude"),
      manifest.roots[0].include,
      manifest.roots[0].exclude,
      manifest.globalExclude,
    );
    const repoHashes = await hashFiles(repoFiles);
    const state = updateStateFiles(emptyState(), ".claude", repoHashes);

    // State keys are prefixed with root.repo
    assert.ok(state.files[".claude/skills/SKILL.md"],
      "State key should be prefixed with root.repo");

    // Now modify and recompute — rootName should match the state prefix
    writeFileSync(join(LOCAL, ".claude", "skills", "SKILL.md"), "# Modified");
    const changes = await computeAllChanges(manifest, REPO, state);
    const modified = changes.filter((c) => c.action === "modified");

    for (const change of modified) {
      const stateKey = `${change.rootName}/${change.relativePath}`;
      assert.ok(state.files[stateKey] !== undefined,
        `State key '${stateKey}' built from rootName + relativePath must exist in state`);
    }
  });
});

describe("discoverFiles include seeding", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("finds an exact root-level include without depending on a full tree walk", async () => {
    writeFileSync(join(LOCAL, ".claude", "settings.json"), "{}");
    mkdirSync(join(LOCAL, ".claude", "nested"), { recursive: true });
    writeFileSync(join(LOCAL, ".claude", "nested", "settings.json"), "{\"nested\":true}");

    const files = await discoverFiles(
      join(LOCAL, ".claude"),
      ["settings.json"],
      [],
      [],
    );

    assert.deepEqual([...files.keys()], ["settings.json"]);
  });

  it("walks from the static include prefix instead of requiring the whole root", async () => {
    writeFileSync(join(LOCAL, ".claude", "CLAUDE.md"), "# Claude");
    mkdirSync(join(LOCAL, ".claude", "skills", "commit"), { recursive: true });
    writeFileSync(join(LOCAL, ".claude", "skills", "commit", "SKILL.md"), "# Skill");

    const files = await discoverFiles(
      join(LOCAL, ".claude"),
      ["skills/**"],
      [],
      [],
    );

    assert.deepEqual([...files.keys()], ["skills/commit/SKILL.md"]);
  });
});

describe("rootName works with dot-prefixed repo paths", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("handles repo paths that start with a dot", async () => {
    writeFileSync(join(LOCAL, ".claude", "CLAUDE.md"), "# Claude");

    const manifest = loadManifest(REPO);
    const changes = await computeAllChanges(manifest, REPO, emptyState());

    const change = changes.find((c) => c.relativePath === "CLAUDE.md");
    assert.ok(change, "Should detect CLAUDE.md");
    assert.equal(change.rootName, ".claude",
      "rootName preserves the dot prefix from repo path");
  });

  it("handles repo paths without a dot prefix", async () => {
    // Add a non-dot-prefixed root
    writeFileSync(
      join(REPO, "rotunda.json"),
      JSON.stringify({
        version: 1,
        roots: [
          {
            name: "clink",
            local: LOCAL + "/clink",
            repo: "clink",
            include: ["*.lua"],
            exclude: [],
          },
        ],
        globalExclude: [],
      }),
    );

    mkdirSync(join(REPO, "clink"), { recursive: true });
    mkdirSync(join(LOCAL, "clink"), { recursive: true });
    writeFileSync(join(LOCAL, "clink", "oh-my-posh.lua"), "-- lua config");

    const manifest = loadManifest(REPO);
    const changes = await computeAllChanges(manifest, REPO, emptyState());

    const change = changes.find((c) => c.relativePath === "oh-my-posh.lua");
    assert.ok(change, "Should detect lua file");
    assert.equal(change.rootName, "clink",
      "rootName equals repo path when no dot prefix");

    // Lookup still works
    const rootDef = manifest.roots.find((r) => r.repo === change.rootName);
    assert.ok(rootDef, "Root lookup via rootName must succeed");
    assert.equal(rootDef.name, "clink");
  });
});

describe("computeChanges rootName is passed through correctly", () => {
  it("passes rootName to all FileChange objects", () => {
    const localHashes = new Map([["file.md", "hash-local"]]);
    const repoHashes = new Map<string, string>();
    const stateFiles = {};

    const changes = computeChanges(".claude", localHashes, repoHashes, stateFiles);

    assert.equal(changes.length, 1);
    assert.equal(changes[0].rootName, ".claude",
      "computeChanges must propagate rootName to each FileChange");
  });

  it("propagates dot-prefixed rootName unchanged", () => {
    const changes = computeChanges(
      ".copilot",
      new Map([["agents/test.md", "abc"]]),
      new Map(),
      {},
    );

    assert.equal(changes[0].rootName, ".copilot");
  });
});
