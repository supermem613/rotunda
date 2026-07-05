import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { GitBackend, resolveBackend } from "../../src/utils/vcs.js";

const TMP = join(tmpdir(), "rotunda-vcs-test");

function initBareRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--bare"], { cwd: dir });
}

function cloneRepo(bare: string, dest: string): void {
  execFileSync("git", ["clone", bare, dest]);
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dest });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dest });
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("resolveBackend", () => {
  it("returns a GitBackend instance by default", () => {
    const backend = resolveBackend(join(TMP, "repo"));
    assert.ok(backend instanceof GitBackend);
  });
});

describe("GitBackend.publish", () => {
  it("commits and pushes the specified paths to the remote", async () => {
    const bare = join(TMP, "bare");
    const clone = join(TMP, "clone");

    initBareRepo(bare);
    cloneRepo(bare, clone);

    writeFileSync(join(clone, "file.txt"), "hello\n");

    await new GitBackend().publish(clone, ["file.txt"], "msg");

    const subject = execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: clone }).toString().trim();
    assert.equal(subject, "msg");

    const content = execFileSync("git", ["show", "HEAD:file.txt"], { cwd: clone }).toString();
    assert.equal(content.replace(/\r\n/g, "\n"), "hello\n");

    const branch = execFileSync("git", ["branch", "--show-current"], { cwd: clone }).toString().trim();
    const cloneHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: clone }).toString().trim();
    const remoteHead = execFileSync("git", ["--git-dir=" + bare, "rev-parse", `refs/heads/${branch}`], {
      cwd: clone,
    })
      .toString()
      .trim();
    assert.equal(remoteHead, cloneHead);
  });
});

describe("GitBackend.pull", () => {
  it("pulls new changes from the remote into another clone", async () => {
    const bare = join(TMP, "bare");
    const cloneA = join(TMP, "clone-a");
    const cloneB = join(TMP, "clone-b");

    initBareRepo(bare);
    cloneRepo(bare, cloneA);

    writeFileSync(join(cloneA, "seed.txt"), "seed\n");
    execFileSync("git", ["add", "."], { cwd: cloneA });
    execFileSync("git", ["commit", "-m", "seed"], { cwd: cloneA });
    execFileSync("git", ["push"], { cwd: cloneA });

    cloneRepo(bare, cloneB);

    writeFileSync(join(cloneA, "new-file.txt"), "from A\n");
    execFileSync("git", ["add", "."], { cwd: cloneA });
    execFileSync("git", ["commit", "-m", "add new file"], { cwd: cloneA });
    execFileSync("git", ["push"], { cwd: cloneA });

    const pulled = await new GitBackend().pull(cloneB);
    assert.equal(pulled, true);

    const content = readFileSync(join(cloneB, "new-file.txt"), "utf-8");
    assert.equal(content.replace(/\r\n/g, "\n"), "from A\n");
  });
});
