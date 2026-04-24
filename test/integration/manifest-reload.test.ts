/**
 * Regression test: when a remote machine pushes a new include glob (or any
 * manifest change), the next `rotunda sync` on another machine must reload
 * the manifest after `git pull` and apply the new patterns immediately —
 * not require a second sync to pick up the newly-mapped files.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, execSync } from "node:child_process";

let TMP: string;
let BARE: string;
let CLONE_A: string;       // remote-modifying machine
let DOTFILES: string;      // machine under test (dotfiles repo clone)
let LOCAL: string;         // machine under test's local target
let LOCAL_A: string;       // clone A's local target (unused but kept symmetric)
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

function runCli(command: string, cwd: string): string {
  writeBinding(cwd);
  const repoRoot = join(import.meta.dirname, "..", "..");
  try {
    return execSync(
      `node --import tsx "${CLI_ENTRY}" ${command}`,
      {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: 30_000,
        env: { ...process.env, HOME: FAKE_HOME, USERPROFILE: FAKE_HOME },
      },
    );
  } catch (err: unknown) {
    const e = err as Error & { stdout?: string; stderr?: string };
    return (e.stdout ?? "") + (e.stderr ?? "");
  }
}

function writeManifest(repoDir: string, includes: string[]): void {
  writeFileSync(
    join(repoDir, "rotunda.json"),
    JSON.stringify({
      version: 1,
      roots: [{
        name: "config",
        local: LOCAL,
        repo: "config",
        include: includes,
        exclude: [],
      }],
      globalExclude: [".git"],
    }, null, 2),
  );
}

function cleanup(): void {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
}

function freshTmp(): void {
  cleanup();
  TMP = mkdtempSync(join(tmpdir(), "rotunda-manifestreload-"));
  BARE = join(TMP, "bare");
  CLONE_A = join(TMP, "clone-a");
  DOTFILES = join(TMP, "dotfiles");
  LOCAL = join(TMP, "local");
  LOCAL_A = join(TMP, "local-a");
  FAKE_HOME = join(TMP, "home");
}

describe("Manifest reload after auto git-pull", () => {
  beforeEach(() => {
    freshTmp();
    initBare();
    cloneAndConfigure(DOTFILES);
    cloneAndConfigure(CLONE_A);

    mkdirSync(join(DOTFILES, "config"), { recursive: true });
    mkdirSync(join(DOTFILES, ".rotunda"), { recursive: true });
    mkdirSync(LOCAL, { recursive: true });
    mkdirSync(LOCAL_A, { recursive: true });

    // Initial manifest: only includes *.json
    writeFileSync(
      join(DOTFILES, "rotunda.json"),
      JSON.stringify({
        version: 1,
        roots: [{
          name: "config",
          local: LOCAL,
          repo: "config",
          include: ["*.json"],
          exclude: [],
        }],
        globalExclude: [".git"],
      }, null, 2),
    );
    writeFileSync(join(DOTFILES, "config", "settings.json"), '{"theme":"dark"}');
    execFileSync("git", ["add", "."], { cwd: DOTFILES });
    execFileSync("git", ["commit", "-m", "initial setup"], { cwd: DOTFILES });
    execFileSync("git", ["push"], { cwd: DOTFILES });

    // Get DOTFILES into a "synced" state so settings.json is mapped.
    runCli("sync -y", DOTFILES);
  });
  afterEach(cleanup);

  it("picks up newly-mapped files in the SAME sync that pulls the new manifest", () => {
    // CLONE_A: pull, then add a new glob "*.toml" plus a matching file, push.
    execFileSync("git", ["pull"], { cwd: CLONE_A });
    writeFileSync(
      join(CLONE_A, "rotunda.json"),
      JSON.stringify({
        version: 1,
        roots: [{
          name: "config",
          local: LOCAL,   // same local path string; doesn't matter for repo-side discovery
          repo: "config",
          include: ["*.json", "*.toml"],
          exclude: [],
        }],
        globalExclude: [".git"],
      }, null, 2),
    );
    writeFileSync(join(CLONE_A, "config", "newly-mapped.toml"), "key = 'value'\n");
    execFileSync("git", ["add", "."], { cwd: CLONE_A });
    execFileSync("git", ["commit", "-m", "add toml glob and file"], { cwd: CLONE_A });
    execFileSync("git", ["push"], { cwd: CLONE_A });

    // Single sync on DOTFILES side: must auto-pull, reload manifest, and
    // apply the newly-mapped *.toml file in this same invocation.
    const output = runCli("sync -y", DOTFILES);

    assert.ok(
      output.includes("Pulled latest"),
      `Expected auto-pull message: ${output}`,
    );

    // The repo-side file exists after pull regardless of the bug — verify the
    // bug fix by checking the local target received it in this same sync.
    assert.ok(
      existsSync(join(DOTFILES, "config", "newly-mapped.toml")),
      "newly-mapped.toml should exist in dotfiles repo after pull",
    );
    assert.ok(
      existsSync(join(LOCAL, "newly-mapped.toml")),
      `newly-mapped.toml should be applied to local in the SAME sync that ` +
      `pulled the new glob. Output:\n${output}`,
    );
  });
});
