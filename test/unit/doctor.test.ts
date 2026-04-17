import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { checkRotundaIgnored } from "../../src/commands/doctor.js";

const TMP = join(import.meta.dirname, "__doctor_tmp__");

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
}

function cleanup(): void {
  rmSync(TMP, { recursive: true, force: true });
}

describe("checkRotundaIgnored", () => {
  const REPO = join(TMP, "repo");

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    initGitRepo(REPO);
  });

  afterEach(cleanup);

  it("passes when .rotunda/ is gitignored", async () => {
    writeFileSync(join(REPO, ".gitignore"), ".rotunda/\n");
    const result = await checkRotundaIgnored(REPO);
    assert.equal(result.status, "pass");
    assert.match(result.message, /gitignored/);
  });

  it("passes when .rotunda is gitignored without trailing slash", async () => {
    writeFileSync(join(REPO, ".gitignore"), ".rotunda\n");
    const result = await checkRotundaIgnored(REPO);
    assert.equal(result.status, "pass");
  });

  it("passes when ignored via a broader pattern", async () => {
    writeFileSync(join(REPO, ".gitignore"), ".*/\n");
    const result = await checkRotundaIgnored(REPO);
    assert.equal(result.status, "pass");
  });

  it("fails when .gitignore is missing", async () => {
    const result = await checkRotundaIgnored(REPO);
    assert.equal(result.status, "fail");
    assert.match(result.message, /NOT gitignored/);
    assert.ok(result.details && result.details.length > 0);
  });

  it("fails when .gitignore exists but excludes .rotunda", async () => {
    writeFileSync(join(REPO, ".gitignore"), "node_modules/\n*.log\n");
    const result = await checkRotundaIgnored(REPO);
    assert.equal(result.status, "fail");
  });

  it("passes (skipped) for a non-git directory", async () => {
    const plain = join(tmpdir(), `rotunda-doctor-test-${process.pid}`);
    mkdirSync(plain, { recursive: true });
    try {
      const result = await checkRotundaIgnored(plain);
      assert.equal(result.status, "pass");
      assert.match(result.message, /not a git repo/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("respects a negation that re-includes .rotunda", async () => {
    writeFileSync(join(REPO, ".gitignore"), ".*/\n!.rotunda/\n");
    const result = await checkRotundaIgnored(REPO);
    assert.equal(result.status, "fail");
  });
});
