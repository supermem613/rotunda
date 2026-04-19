import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadManifest } from "../../src/core/manifest.js";
import { emptyState, updateStateFiles, saveState } from "../../src/core/state.js";
import { computeAllChanges, discoverFiles, hashFiles } from "../../src/core/engine.js";
import { pullCommand } from "../../src/commands/pull.js";

const TMP = join(tmpdir(), "rotunda-pull-restore-test");
const REPO = join(TMP, "repo");
const LOCAL = join(TMP, "local");
const FAKE_HOME = join(TMP, "home");

let savedHome: string | undefined;
let savedUserProfile: string | undefined;

function setup() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(REPO, ".claude", "skills", "commit"), { recursive: true });
  mkdirSync(join(LOCAL, ".claude", "skills", "commit"), { recursive: true });
  mkdirSync(join(REPO, ".rotunda"), { recursive: true });
  mkdirSync(FAKE_HOME, { recursive: true });

  // Point os.homedir() at our fake home so pullCommand reads our config.
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = FAKE_HOME;
  process.env.USERPROFILE = FAKE_HOME;

  // Write global config binding rotunda to REPO.
  writeFileSync(
    join(FAKE_HOME, ".rotunda.json"),
    JSON.stringify({ version: 1, dotfilesRepo: REPO, cdShell: null }, null, 2),
  );

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
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
  rmSync(TMP, { recursive: true, force: true });
}

describe("Bug repro: pull should restore locally-deleted dir from repo", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("detects locally-deleted file as restorable on pull", async () => {
    // Both repo and local have the file
    const repoSkill = join(REPO, ".claude", "skills", "commit", "SKILL.md");
    const localSkill = join(LOCAL, ".claude", "skills", "commit", "SKILL.md");
    writeFileSync(repoSkill, "# Skill content");
    writeFileSync(localSkill, "# Skill content");

    const manifest = loadManifest(REPO);

    // State reflects last sync — both sides matched
    const repoFiles = await discoverFiles(
      join(REPO, ".claude"),
      manifest.roots[0].include,
      manifest.roots[0].exclude,
      manifest.globalExclude,
    );
    const repoHashes = await hashFiles(repoFiles);
    let state = updateStateFiles(emptyState(), ".claude", repoHashes);

    // Now user removes the dir locally
    rmSync(join(LOCAL, ".claude", "skills", "commit"), { recursive: true, force: true });

    const changes = await computeAllChanges(manifest, REPO, state);

    // The change is detected as deleted on local side
    const deletedLocal = changes.find(
      (c) => c.relativePath === "skills/commit/SKILL.md" && c.action === "deleted" && c.side === "local",
    );
    assert.ok(deletedLocal, "Engine should detect locally-deleted file");

    // Now drive the pull command end-to-end. After pull, the file should be restored locally.
    await saveState(REPO, state);
    await pullCommand({ yes: true });

    assert.ok(
      existsSync(localSkill),
      "After `rotunda pull`, locally-deleted file should be restored from repo",
    );
    assert.equal(readFileSync(localSkill, "utf-8"), "# Skill content");
  });
});
