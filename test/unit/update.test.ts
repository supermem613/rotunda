import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitPullMadeNoChanges, updateCommand } from "../../src/commands/update.js";

describe("updateCommand", () => {
  it("skips install and build when git pull made no changes", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "rotunda-update-"));
    try {
      mkdirSync(join(repoRoot, ".git"), { recursive: true });
      const commands: string[] = [];
      await updateCommand({
        repoRoot,
        isGitRepo: async () => true,
        runGit: async (args) => {
          commands.push(`git ${args.join(" ")}`);
          return { stdout: "Already up to date.\n", stderr: "" };
        },
        runCommand: async (command) => {
          commands.push(command);
        },
      });
      assert.deepEqual(commands, ["git pull --ff-only"]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("runs install and build when git pull returns changes", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "rotunda-update-"));
    try {
      mkdirSync(join(repoRoot, ".git"), { recursive: true });
      const commands: string[] = [];
      await updateCommand({
        repoRoot,
        isGitRepo: async () => true,
        runGit: async (args) => {
          commands.push(`git ${args.join(" ")}`);
          return { stdout: "Fast-forward\n package.json | 2 +-\n", stderr: "" };
        },
        runCommand: async (command) => {
          commands.push(command);
        },
      });
      assert.deepEqual(commands, [
        "git pull --ff-only",
        "npm install --no-audit --no-fund",
        "npm run build",
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("recognizes current and legacy no-change git pull output", () => {
    assert.equal(gitPullMadeNoChanges("Already up to date."), true);
    assert.equal(gitPullMadeNoChanges("Already up-to-date."), true);
    assert.equal(gitPullMadeNoChanges("Updating abc..def\nFast-forward"), false);
  });
});
