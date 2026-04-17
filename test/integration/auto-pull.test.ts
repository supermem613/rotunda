/**
 * Integration tests for the auto git-pull behavior in sync, pull, and push commands.
 *
 * These tests run the real CLI as a subprocess with `-y` to skip interactive prompts,
 * verifying that each command auto-pulls from the remote before computing changes.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync, writeFileSync, readFileSync, rmSync, existsSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync, execSync } from "node:child_process";

const TMP = join(import.meta.dirname, "__autopull_tmp__");
const BARE = join(TMP, "bare");        // bare "remote"
const CLONE_A = join(TMP, "clone-a");  // simulates another machine pushing
const DOTFILES = join(TMP, "dotfiles"); // the repo where rotunda commands run
const LOCAL = join(TMP, "local");       // local target for sync roots

// Path to the CLI entry point
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

function runCli(command: string, cwd: string): string {
  try {
    return execSync(
      `node --import tsx "${CLI_ENTRY}" ${command}`,
      { cwd, encoding: "utf-8", timeout: 30_000 },
    );
  } catch (err: unknown) {
    const e = err as Error & { stdout?: string; stderr?: string };
    // Return combined output even on non-zero exit (e.g., "nothing to push")
    return (e.stdout ?? "") + (e.stderr ?? "");
  }
}

function setupRotundaRepo(): void {
  // Initialize the dotfiles repo structure
  mkdirSync(join(DOTFILES, "config"), { recursive: true });
  mkdirSync(join(DOTFILES, ".rotunda"), { recursive: true });
  mkdirSync(LOCAL, { recursive: true });

  // Create rotunda.json manifest
  writeFileSync(
    join(DOTFILES, "rotunda.json"),
    JSON.stringify({
      version: 1,
      roots: [{
        name: "config",
        local: LOCAL,
        repo: "config",
        include: ["**"],
        exclude: [],
      }],
      globalExclude: [".git"],
    }),
  );

  // Initial commit with manifest + config dir
  writeFileSync(join(DOTFILES, "config", "settings.json"), '{"theme":"dark"}');
  execFileSync("git", ["add", "."], { cwd: DOTFILES });
  execFileSync("git", ["commit", "-m", "initial setup"], { cwd: DOTFILES });
  execFileSync("git", ["push"], { cwd: DOTFILES });
}

function cleanup(): void {
  rmSync(TMP, { recursive: true, force: true });
}

describe("Auto git-pull: sync command", () => {
  beforeEach(() => {
    cleanup();
    initBare();
    cloneAndConfigure(DOTFILES);
    cloneAndConfigure(CLONE_A);
    setupRotundaRepo();
  });
  afterEach(cleanup);

  it("pulls remote changes before detecting sync changes", () => {
    // Clone A pushes a new file to the remote
    mkdirSync(join(CLONE_A, "config"), { recursive: true });

    // Need to pull first to get the initial state
    execFileSync("git", ["pull"], { cwd: CLONE_A });
    writeFileSync(join(CLONE_A, "config", "remote-file.txt"), "from remote");
    execFileSync("git", ["add", "."], { cwd: CLONE_A });
    execFileSync("git", ["commit", "-m", "add remote file"], { cwd: CLONE_A });
    execFileSync("git", ["push"], { cwd: CLONE_A });

    // DOTFILES doesn't have this file yet — sync should auto-pull first
    const output = runCli("sync -y", DOTFILES);

    // Verify auto-pull happened
    assert.ok(
      output.includes("Pulled latest") || output.includes("Pull"),
      `Expected auto-pull message in output: ${output}`,
    );

    // Verify the file was pulled into the repo
    assert.ok(
      existsSync(join(DOTFILES, "config", "remote-file.txt")),
      "remote-file.txt should exist in dotfiles repo after auto-pull",
    );
  });

  it("continues normally when already up to date", () => {
    const output = runCli("sync -y", DOTFILES);
    // Should not crash, should not show pull message
    assert.ok(!output.includes("git pull failed"), `Should not fail: ${output}`);
  });
});

describe("Auto git-pull: pull command", () => {
  beforeEach(() => {
    cleanup();
    initBare();
    cloneAndConfigure(DOTFILES);
    cloneAndConfigure(CLONE_A);
    setupRotundaRepo();
  });
  afterEach(cleanup);

  it("pulls remote changes and applies them to local", () => {
    // Clone A pushes a new config file
    execFileSync("git", ["pull"], { cwd: CLONE_A });
    mkdirSync(join(CLONE_A, "config"), { recursive: true });
    writeFileSync(join(CLONE_A, "config", "new-setting.toml"), "key = 'value'");
    execFileSync("git", ["add", "."], { cwd: CLONE_A });
    execFileSync("git", ["commit", "-m", "add toml"], { cwd: CLONE_A });
    execFileSync("git", ["push"], { cwd: CLONE_A });

    // Run pull — should auto-pull from remote, then copy to local
    const output = runCli("pull -y", DOTFILES);

    // Auto-pull happened
    assert.ok(
      output.includes("Pulled latest") || output.includes("Pull"),
      `Expected auto-pull in output: ${output}`,
    );

    // The file should have been pulled into DOTFILES repo
    assert.ok(
      existsSync(join(DOTFILES, "config", "new-setting.toml")),
      "new-setting.toml should exist in dotfiles repo",
    );

    // And applied to local
    assert.ok(
      existsSync(join(LOCAL, "new-setting.toml")),
      "new-setting.toml should be copied to local",
    );
  });
});

describe("Auto git-pull: push command", () => {
  beforeEach(() => {
    cleanup();
    initBare();
    cloneAndConfigure(DOTFILES);
    cloneAndConfigure(CLONE_A);
    setupRotundaRepo();
  });
  afterEach(cleanup);

  it("pulls remote first, then pushes local changes", () => {
    // Clone A pushes a change first
    execFileSync("git", ["pull"], { cwd: CLONE_A });
    mkdirSync(join(CLONE_A, "config"), { recursive: true });
    writeFileSync(join(CLONE_A, "config", "remote-only.txt"), "remote");
    execFileSync("git", ["add", "."], { cwd: CLONE_A });
    execFileSync("git", ["commit", "-m", "remote change"], { cwd: CLONE_A });
    execFileSync("git", ["push"], { cwd: CLONE_A });

    // Add a local file that should be pushed
    writeFileSync(join(LOCAL, "local-new.txt"), "local content");

    // Run push — should auto-pull first, then detect and push local changes
    const output = runCli("push -y", DOTFILES);

    // Auto-pull happened
    assert.ok(
      output.includes("Pulled latest") || output.includes("Pull"),
      `Expected auto-pull in output: ${output}`,
    );

    // Remote file should now exist locally (from the pull)
    assert.ok(
      existsSync(join(DOTFILES, "config", "remote-only.txt")),
      "remote-only.txt should exist after auto-pull",
    );
  });
});

describe("Auto git-pull: failure handling", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(join(TMP, "no-remote"), { recursive: true });
    const dir = join(TMP, "no-remote");
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    mkdirSync(join(dir, ".rotunda"), { recursive: true });
    mkdirSync(join(dir, "config"), { recursive: true });
    mkdirSync(join(LOCAL, "sub"), { recursive: true });

    writeFileSync(
      join(dir, "rotunda.json"),
      JSON.stringify({
        version: 1,
        roots: [{
          name: "config",
          local: LOCAL,
          repo: "config",
          include: ["**"],
          exclude: [],
        }],
        globalExclude: [".git"],
      }),
    );
    writeFileSync(join(dir, "config", "a.txt"), "content");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  });
  afterEach(cleanup);

  it("warns but continues when git pull fails (no remote)", () => {
    const dir = join(TMP, "no-remote");
    const output = runCli("sync -y", dir);

    // Should show warning, not crash
    assert.ok(
      output.includes("git pull failed") || output.includes("Sync") || output.includes("sync"),
      `Command should succeed despite pull failure: ${output}`,
    );
  });
});

describe("Auto git-pull: non-git directory", () => {
  beforeEach(() => {
    cleanup();
    const dir = join(TMP, "non-git");
    mkdirSync(join(dir, ".rotunda"), { recursive: true });
    mkdirSync(join(dir, "config"), { recursive: true });
    mkdirSync(LOCAL, { recursive: true });

    writeFileSync(
      join(dir, "rotunda.json"),
      JSON.stringify({
        version: 1,
        roots: [{
          name: "config",
          local: LOCAL,
          repo: "config",
          include: ["**"],
          exclude: [],
        }],
        globalExclude: [".git"],
      }),
    );
  });
  afterEach(cleanup);

  it("skips auto-pull entirely for non-git directories", () => {
    const dir = join(TMP, "non-git");
    const output = runCli("sync -y", dir);

    // Should not mention pull at all
    assert.ok(!output.includes("Pulled latest"), "Should not attempt pull in non-git dir");
    assert.ok(!output.includes("git pull failed"), "Should not show pull failure in non-git dir");
  });
});

function getRemoteLog(bare: string): string {
  return execFileSync("git", ["log", "--oneline", "--all"], { cwd: bare, encoding: "utf-8" });
}

describe("Git commit+push: sync command", () => {
  beforeEach(() => {
    cleanup();
    initBare();
    cloneAndConfigure(DOTFILES);
    cloneAndConfigure(CLONE_A);
    setupRotundaRepo();
  });
  afterEach(cleanup);

  it("commits and pushes local→repo changes to remote", () => {
    // Add a file locally that should be synced to repo
    writeFileSync(join(LOCAL, "new-local.txt"), "from local");

    const output = runCli("sync -y", DOTFILES);

    // Should mention commit+push
    assert.ok(
      output.includes("Committed and pushed"),
      `Expected commit+push message: ${output}`,
    );

    // Verify the commit reached the bare remote
    const log = getRemoteLog(BARE);
    assert.ok(
      log.includes("rotunda sync"),
      `Remote should have rotunda sync commit: ${log}`,
    );

    // Clone A should be able to pull and see the file
    execFileSync("git", ["pull"], { cwd: CLONE_A });
    assert.ok(
      existsSync(join(CLONE_A, "config", "new-local.txt")),
      "new-local.txt should be visible in clone A after pull",
    );
  });

  it("commits state changes even for pull-direction sync", () => {
    // Push a new file from clone A
    execFileSync("git", ["pull"], { cwd: CLONE_A });
    mkdirSync(join(CLONE_A, "config"), { recursive: true });
    writeFileSync(join(CLONE_A, "config", "from-remote.txt"), "remote content");
    execFileSync("git", ["add", "."], { cwd: CLONE_A });
    execFileSync("git", ["commit", "-m", "add remote file"], { cwd: CLONE_A });
    execFileSync("git", ["push"], { cwd: CLONE_A });

    const output = runCli("sync -y", DOTFILES);

    // State changes should be committed and pushed
    const log = getRemoteLog(BARE);
    assert.ok(
      log.includes("rotunda sync"),
      `Remote should have rotunda sync commit for state update: ${log}`,
    );
  });
});

describe("Git commit+push: pull command", () => {
  beforeEach(() => {
    cleanup();
    initBare();
    cloneAndConfigure(DOTFILES);
    cloneAndConfigure(CLONE_A);
    setupRotundaRepo();
  });
  afterEach(cleanup);

  it("commits and pushes state changes after pulling", () => {
    // Push a new file from clone A
    execFileSync("git", ["pull"], { cwd: CLONE_A });
    mkdirSync(join(CLONE_A, "config"), { recursive: true });
    writeFileSync(join(CLONE_A, "config", "pulled-file.txt"), "content");
    execFileSync("git", ["add", "."], { cwd: CLONE_A });
    execFileSync("git", ["commit", "-m", "add file"], { cwd: CLONE_A });
    execFileSync("git", ["push"], { cwd: CLONE_A });

    const output = runCli("pull -y", DOTFILES);

    assert.ok(
      output.includes("Committed and pushed"),
      `Expected commit+push message: ${output}`,
    );

    // Verify state commit reached the remote
    const log = getRemoteLog(BARE);
    assert.ok(
      log.includes("rotunda pull"),
      `Remote should have rotunda pull commit: ${log}`,
    );
  });
});

describe("Git commit+push: push command", () => {
  beforeEach(() => {
    cleanup();
    initBare();
    cloneAndConfigure(DOTFILES);
    cloneAndConfigure(CLONE_A);
    setupRotundaRepo();
  });
  afterEach(cleanup);

  it("commits and pushes local changes to remote", () => {
    // Add a local file
    writeFileSync(join(LOCAL, "pushed-file.txt"), "local content");

    const output = runCli("push -y", DOTFILES);

    assert.ok(
      output.includes("Committed and pushed"),
      `Expected commit+push message: ${output}`,
    );

    // Verify commit reached the bare remote
    const log = getRemoteLog(BARE);
    assert.ok(
      log.includes("rotunda push"),
      `Remote should have rotunda push commit: ${log}`,
    );

    // Clone A should be able to pull and see the file
    execFileSync("git", ["pull"], { cwd: CLONE_A });
    assert.ok(
      existsSync(join(CLONE_A, "config", "pushed-file.txt")),
      "pushed-file.txt should be visible in clone A after pull",
    );
  });
});

describe("CLI registers update command", () => {
  it("rotunda update appears in --help output", () => {
    // Run from the repo root so we don't need a rotunda.json
    const repoRoot = join(import.meta.dirname, "..", "..");
    const output = runCli("--help", repoRoot);
    assert.ok(output.includes("update"), `--help should list update command: ${output}`);
  });

  it("rotunda update --help shows description", () => {
    const repoRoot = join(import.meta.dirname, "..", "..");
    const output = runCli("update --help", repoRoot);
    assert.ok(
      output.includes("Self-update") || output.includes("git pull"),
      `update --help should show description: ${output}`,
    );
  });
});
