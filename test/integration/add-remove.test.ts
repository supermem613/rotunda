import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

let TMP: string;
let BARE: string;
let CLONE_A: string;
let DOTFILES: string;
let LOCAL_CLAUDE: string;
let FAKE_HOME: string;

const CLI_ENTRY = join(import.meta.dirname, "..", "..", "src", "cli.ts");

function initBare(): void {
  mkdirSync(BARE, { recursive: true });
  execFileSync("git", ["init", "--bare"], { cwd: BARE });
}

function cloneAndConfigure(dest: string): void {
  execFileSync("git", ["clone", BARE, dest]);
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dest });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dest });
}

function writeBinding(repoPath: string): void {
  mkdirSync(FAKE_HOME, { recursive: true });
  writeFileSync(
    join(FAKE_HOME, ".rotunda.json"),
    JSON.stringify({ version: 1, dotfilesRepo: repoPath, cdShell: null }, null, 2),
  );
}

function runCli(args: string[], cwd: string, input = ""): string {
  writeBinding(cwd);
  const repoRoot = join(import.meta.dirname, "..", "..");
  try {
    return execFileSync(
      "node",
      ["--import", "tsx", CLI_ENTRY, ...args],
      {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: 30_000,
        input,
        env: { ...process.env, HOME: FAKE_HOME, USERPROFILE: FAKE_HOME },
      },
    );
  } catch (err: unknown) {
    const e = err as Error & { stdout?: string; stderr?: string };
    return (e.stdout ?? "") + (e.stderr ?? "");
  }
}

function getRemoteLog(): string {
  return execFileSync("git", ["log", "--oneline", "--all"], { cwd: BARE, encoding: "utf-8" });
}

function setupRepo(roots: Array<{
  name: string;
  local: string;
  repo: string;
  include: string[];
  exclude?: string[];
}>): void {
  mkdirSync(join(DOTFILES, ".claude"), { recursive: true });
  mkdirSync(join(DOTFILES, ".rotunda"), { recursive: true });
  mkdirSync(LOCAL_CLAUDE, { recursive: true });

  writeFileSync(join(DOTFILES, ".gitignore"), ".rotunda/\n");
  writeFileSync(
    join(DOTFILES, "rotunda.json"),
    JSON.stringify({
      version: 1,
      roots: roots.map((root) => ({
        ...root,
        exclude: root.exclude ?? [],
      })),
      globalExclude: [".git"],
    }, null, 2) + "\n",
  );

  execFileSync("git", ["add", "."], { cwd: DOTFILES });
  execFileSync("git", ["commit", "-m", "initial setup"], { cwd: DOTFILES });
  execFileSync("git", ["push"], { cwd: DOTFILES });
}

function writeState(stateFiles: Record<string, { hash: string; size: number; syncedAt: string }>): void {
  writeFileSync(
    join(DOTFILES, ".rotunda", "state.json"),
    JSON.stringify({
      lastSync: new Date().toISOString(),
      files: stateFiles,
      deferred: {},
    }, null, 2) + "\n",
  );
}

function cleanup(): void {
  if (TMP) {
    rmSync(TMP, { recursive: true, force: true });
  }
}

function freshTmp(): void {
  cleanup();
  TMP = mkdtempSync(join(tmpdir(), "rotunda-add-remove-"));
  BARE = join(TMP, "bare");
  CLONE_A = join(TMP, "clone-a");
  DOTFILES = join(TMP, "dotfiles");
  LOCAL_CLAUDE = join(TMP, "local-claude");
  FAKE_HOME = join(TMP, "home");
}

describe("rotunda add", () => {
  beforeEach(() => {
    freshTmp();
    initBare();
    cloneAndConfigure(DOTFILES);
    cloneAndConfigure(CLONE_A);
    setupRepo([{ name: "claude", local: LOCAL_CLAUDE, repo: ".claude", include: ["CLAUDE.md"] }]);
  });
  afterEach(cleanup);

  it("adds a directory path under an existing root", () => {
    mkdirSync(join(LOCAL_CLAUDE, "skills", "commit"), { recursive: true });
    writeFileSync(join(LOCAL_CLAUDE, "skills", "commit", "SKILL.md"), "# Commit");

    const output = runCli(["add", join(LOCAL_CLAUDE, "skills", "commit")], DOTFILES, "y\n");

    assert.ok(output.includes("Dotfiles repo changes:"), output);
    assert.ok(!output.includes("Repo changes:"), output);
    assert.ok(!output.includes("State changes:"), output);
    assert.ok(output.includes("Proceed with add?"), output);
    assert.ok(output.includes("add  rotunda.json"), output);
    assert.ok(output.includes("add  .claude/skills/commit/SKILL.md"), output);
    assert.ok(output.includes("Committed and pushed"), output);

    const manifest = JSON.parse(readFileSync(join(DOTFILES, "rotunda.json"), "utf-8")) as {
      roots: Array<{ include: string[] }>;
    };
    assert.ok(manifest.roots[0].include.includes("skills/commit/**"));
    assert.ok(existsSync(join(DOTFILES, ".claude", "skills", "commit", "SKILL.md")));

    execFileSync("git", ["pull"], { cwd: CLONE_A });
    assert.ok(existsSync(join(CLONE_A, ".claude", "skills", "commit", "SKILL.md")));
  });

  it("creates a new root when no existing root matches", () => {
    mkdirSync(FAKE_HOME, { recursive: true });
    writeFileSync(join(FAKE_HOME, ".c.json"), "{\"enabled\":true}");

    const output = runCli(["add", "~/.c.json"], DOTFILES, "\ny\n");

    assert.ok(output.includes("Root name [home]"), output);
    assert.ok(output.includes("Proceed with add?"), output);
    assert.ok(output.includes("Committed and pushed"), output);

    const manifest = JSON.parse(readFileSync(join(DOTFILES, "rotunda.json"), "utf-8")) as {
      roots: Array<{ name: string; local: string; repo: string; include: string[] }>;
    };
    const homeRoot = manifest.roots.find((root) => root.name === "home");
    assert.ok(homeRoot);
    assert.equal(homeRoot!.local, "~");
    assert.equal(homeRoot!.repo, ".home");
    assert.deepEqual(homeRoot!.include, [".c.json"]);
    assert.ok(existsSync(join(DOTFILES, ".home", ".c.json")));
  });

  it("commits successfully when repo-local CRLF conversion would otherwise block git add", () => {
    execFileSync("git", ["config", "--local", "core.autocrlf", "true"], { cwd: DOTFILES });
    execFileSync("git", ["config", "--local", "core.safecrlf", "true"], { cwd: DOTFILES });
    mkdirSync(FAKE_HOME, { recursive: true });
    writeFileSync(join(FAKE_HOME, ".crlf-repro.json"), "{\"enabled\":true}\n");

    const output = runCli(["add", "~/.crlf-repro.json"], DOTFILES, "\ny\n");

    assert.ok(output.includes("Committed and pushed"), output);
    const repoAutocrlf = execFileSync("git", ["config", "--local", "--get", "core.autocrlf"], {
      cwd: DOTFILES,
      encoding: "utf-8",
    }).trim();
    const repoSafecrlf = execFileSync("git", ["config", "--local", "--get", "core.safecrlf"], {
      cwd: DOTFILES,
      encoding: "utf-8",
    }).trim();
    assert.equal(repoAutocrlf, "true");
    assert.equal(repoSafecrlf, "true");
  });

  it("cancels cleanly without changing the manifest or repo files", () => {
    mkdirSync(join(LOCAL_CLAUDE, "skills", "draft"), { recursive: true });
    writeFileSync(join(LOCAL_CLAUDE, "skills", "draft", "SKILL.md"), "# Draft");

    const beforeLog = getRemoteLog();
    const output = runCli(["add", join(LOCAL_CLAUDE, "skills", "draft")], DOTFILES, "n\n");

    assert.ok(output.includes("Proceed with add?"), output);
    assert.ok(output.includes("Cancelled"), output);
    const manifest = JSON.parse(readFileSync(join(DOTFILES, "rotunda.json"), "utf-8")) as {
      roots: Array<{ include: string[] }>;
    };
    assert.ok(!manifest.roots[0].include.includes("skills/draft/**"));
    assert.ok(!existsSync(join(DOTFILES, ".claude", "skills", "draft", "SKILL.md")));
    assert.equal(getRemoteLog(), beforeLog);
  });
});

describe("rotunda remove", () => {
  beforeEach(() => {
    freshTmp();
    initBare();
    cloneAndConfigure(DOTFILES);
    cloneAndConfigure(CLONE_A);
  });
  afterEach(cleanup);

  it("adds an exclude when removing a path covered by a broader include", () => {
    setupRepo([{ name: "claude", local: LOCAL_CLAUDE, repo: ".claude", include: ["CLAUDE.md", "skills/**"] }]);
    mkdirSync(join(LOCAL_CLAUDE, "skills", "commit"), { recursive: true });
    mkdirSync(join(DOTFILES, ".claude", "skills", "commit"), { recursive: true });
    writeFileSync(join(LOCAL_CLAUDE, "skills", "commit", "SKILL.md"), "# Local copy");
    writeFileSync(join(DOTFILES, ".claude", "skills", "commit", "SKILL.md"), "# Repo copy");
    writeState({
      ".claude/skills/commit/SKILL.md": {
        hash: "hash-commit",
        size: 0,
        syncedAt: new Date().toISOString(),
      },
      ".claude/skills/commit/stale.md": {
        hash: "hash-stale",
        size: 0,
        syncedAt: new Date().toISOString(),
      },
    });
    execFileSync("git", ["add", "."], { cwd: DOTFILES });
    execFileSync("git", ["commit", "-m", "seed tracked skill"], { cwd: DOTFILES });
    execFileSync("git", ["push"], { cwd: DOTFILES });

    const output = runCli(["remove", join(LOCAL_CLAUDE, "skills", "commit")], DOTFILES, "y\n");

    assert.ok(output.includes("Dotfiles repo changes:"), output);
    assert.ok(!output.includes("Repo changes:"), output);
    assert.ok(!output.includes("State changes:"), output);
    assert.ok(output.includes("Proceed with remove?"), output);
    assert.ok(output.includes("add  rotunda.json"), output);
    assert.ok(output.includes("remove  .claude/skills/commit/SKILL.md"), output);
    assert.ok(output.includes("Committed and pushed"), output);

    const manifest = JSON.parse(readFileSync(join(DOTFILES, "rotunda.json"), "utf-8")) as {
      roots: Array<{ include: string[]; exclude: string[] }>;
    };
    assert.ok(manifest.roots[0].include.includes("skills/**"));
    assert.ok(manifest.roots[0].exclude.includes("skills/commit/**"));
    assert.ok(!existsSync(join(DOTFILES, ".claude", "skills", "commit", "SKILL.md")));
    assert.ok(existsSync(join(LOCAL_CLAUDE, "skills", "commit", "SKILL.md")));

    const state = JSON.parse(readFileSync(join(DOTFILES, ".rotunda", "state.json"), "utf-8")) as {
      files: Record<string, unknown>;
    };
    assert.ok(!state.files[".claude/skills/commit/SKILL.md"]);
    assert.ok(!state.files[".claude/skills/commit/stale.md"]);
  });

  it("removes the whole root when given the root directory path", () => {
    setupRepo([{ name: "claude", local: LOCAL_CLAUDE, repo: ".claude", include: ["**"] }]);
    writeFileSync(join(LOCAL_CLAUDE, "CLAUDE.md"), "# Claude");
    writeFileSync(join(DOTFILES, ".claude", "CLAUDE.md"), "# Claude");
    writeState({
      ".claude/CLAUDE.md": {
        hash: "hash",
        size: 0,
        syncedAt: new Date().toISOString(),
      },
    });
    execFileSync("git", ["add", "."], { cwd: DOTFILES });
    execFileSync("git", ["commit", "-m", "seed root"], { cwd: DOTFILES });
    execFileSync("git", ["push"], { cwd: DOTFILES });

    const output = runCli(["remove", LOCAL_CLAUDE], DOTFILES, "y\n");

    assert.ok(output.includes("Proceed with remove?"), output);
    const manifest = JSON.parse(readFileSync(join(DOTFILES, "rotunda.json"), "utf-8")) as {
      roots: unknown[];
    };
    assert.equal(manifest.roots.length, 0);
    assert.ok(!existsSync(join(DOTFILES, ".claude", "CLAUDE.md")));
    assert.ok(existsSync(join(LOCAL_CLAUDE, "CLAUDE.md")));
  });
});
