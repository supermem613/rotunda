import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmp: string;
let dotfiles: string;
let local: string;
let fakeHome: string;

const CLI_ENTRY = join(import.meta.dirname, "..", "..", "src", "cli.ts");

function runCli(command: string): string {
  writeFileSync(
    join(fakeHome, ".rotunda.json"),
    JSON.stringify({ version: 1, dotfilesRepo: dotfiles, cdShell: null }, null, 2),
  );

  const repoRoot = join(import.meta.dirname, "..", "..");
  return execSync(
    `node --import tsx "${CLI_ENTRY}" ${command}`,
    {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    },
  );
}

function setupRepo(): void {
  tmp = mkdtempSync(join(tmpdir(), "rotunda-list-"));
  dotfiles = join(tmp, "dotfiles");
  local = join(tmp, "local");
  fakeHome = join(tmp, "home");

  mkdirSync(join(dotfiles, "config", "sub"), { recursive: true });
  mkdirSync(join(local, "sub"), { recursive: true });
  mkdirSync(fakeHome, { recursive: true });

  writeFileSync(
    join(dotfiles, "rotunda.json"),
    JSON.stringify({
      version: 1,
      roots: [{
        name: "config",
        local,
        repo: "config",
        include: ["**"],
        exclude: ["*.tmp"],
      }],
      globalExclude: [".git"],
    }, null, 2),
  );
  writeFileSync(join(dotfiles, "config", "settings.json"), "{}");
  writeFileSync(join(dotfiles, "config", "repo-only.txt"), "repo");
  writeFileSync(join(local, "settings.json"), "{}");
  writeFileSync(join(local, "local-only.txt"), "local");
  writeFileSync(join(local, "sub", "nested.txt"), "nested");
}

function cleanup(): void {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("list command", () => {
  beforeEach(setupRepo);
  afterEach(cleanup);

  it("renders a rich inventory with root metadata, status labels, and counts", () => {
    const output = runCli("list");

    assert.match(output, /rotunda inventory/);
    assert.match(output, /roots \(1\)/);
    assert.match(output, /config\s+4 files/);
    assert.match(output, /local:/);
    assert.match(output, /repo:/);
    assert.match(output, /include:/);
    assert.match(output, /exclude:/);
    assert.match(output, /files \(4\)/);
    assert.match(output, /settings\.json\s+synced/);
    assert.match(output, /local-only\.txt\s+local-only/);
    assert.match(output, /repo-only\.txt\s+repo-only/);
    assert.match(output, /4 files: 1 synced, 2 local-only, 1 repo-only/);
    assert.match(output, /Legend: .*synced.*local-only.*repo-only/);
  });
});
