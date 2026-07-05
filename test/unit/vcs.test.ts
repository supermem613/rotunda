import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { GitBackend, isSodaHookBlock, resolveBackend, resolveSelfUpdateBackend, sodaPreflight, SodaBackend, type SodaRunner } from "../../src/utils/vcs.js";

const TMP = join(tmpdir(), "rotunda-vcs-test");

type MockEnvelope = { ok: true; data?: unknown } | { ok: false; error: string };

function createMockRunner(responses: Array<MockEnvelope | Error>, calls: string[][]): SodaRunner {
  return async (args: string[]) => {
    calls.push([...args]);
    const response = responses.shift();
    if (!response) {
      throw new Error(`unexpected runner args: ${args.join(" ")}`);
    }
    if (response instanceof Error) {
      throw response;
    }
    return { stdout: JSON.stringify(response), stderr: "" };
  };
}

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

describe("resolveBackend (manifest-driven)", () => {
  it("returns SodaBackend when the manifest declares vcs soda", () => {
    const dir = join(TMP, "manifest-soda");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "rotunda.json"),
      JSON.stringify({
        version: 1,
        roots: [{ name: "d", local: "/l", repo: "r", include: [], exclude: [] }],
        globalExclude: [],
        vcs: "soda",
      }),
    );

    const backend = resolveBackend(dir);
    assert.ok(backend instanceof SodaBackend);
  });

  it("returns GitBackend when the manifest declares vcs git", () => {
    const dir = join(TMP, "manifest-git");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "rotunda.json"),
      JSON.stringify({
        version: 1,
        roots: [{ name: "d", local: "/l", repo: "r", include: [], exclude: [] }],
        globalExclude: [],
        vcs: "git",
      }),
    );

    const backend = resolveBackend(dir);
    assert.ok(backend instanceof GitBackend);
  });

  it("returns GitBackend when no manifest is present", () => {
    const dir = join(TMP, "no-manifest");
    mkdirSync(dir, { recursive: true });

    const backend = resolveBackend(dir);
    assert.ok(backend instanceof GitBackend);
  });

  it("throws for an invalid manifest that exists", () => {
    const dir = join(TMP, "invalid-manifest");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rotunda.json"), JSON.stringify({ version: "1", roots: [], globalExclude: [] }));

    assert.throws(() => resolveBackend(dir), /Invalid manifest/);
  });
});

describe("isSodaHookBlock", () => {
  it("detects the soda hook-guard message", () => {
    assert.equal(isSodaHookBlock("soda: raw git commit blocked in this sd-powered repo"), true);
  });

  it("detects the push guard message", () => {
    assert.equal(isSodaHookBlock("soda: raw git push blocked in this sd-powered repo"), true);
  });

  it("returns false for an unrelated git error", () => {
    assert.equal(isSodaHookBlock("fatal: not a git repository"), false);
  });
});

describe("sodaPreflight", () => {
  it("returns ok when sd status succeeds", async () => {
    const mockRunner = async () => ({
      stdout: JSON.stringify({
        ok: true,
        command: "status",
        schemaVersion: 2,
        timingMs: 1,
        data: { summary: { repoRoot: "/x", clean: true }, files: [], conflicts: [], diagnostics: [] },
      }),
      stderr: "",
    });

    assert.deepEqual(await sodaPreflight("/x", mockRunner), { ok: true });
  });

  it("returns a missing-command reason if the runner throws", async () => {
    const mockRunner = async () => {
      throw new Error("missing sd");
    };

    assert.deepEqual(await sodaPreflight("/x", mockRunner), { ok: false, reason: "sd command not available" });
  });

  it("returns the sd error when status reports a failure", async () => {
    const mockRunner = async () => ({
      stdout: JSON.stringify({
        ok: false,
        command: "status",
        schemaVersion: 2,
        timingMs: 1,
        error: "not a soda repo",
        hint: "try soda init",
      }),
      stderr: "",
    });

    assert.deepEqual(await sodaPreflight("/x", mockRunner), { ok: false, reason: "not a soda repo" });
  });

  it("uses the injected runner in SodaBackend.isRepo", async () => {
    const mockOkRunner = async () => ({
      stdout: JSON.stringify({
        ok: true,
        command: "status",
        schemaVersion: 2,
        timingMs: 1,
        data: { summary: { repoRoot: "/x", clean: true }, files: [], conflicts: [], diagnostics: [] },
      }),
      stderr: "",
    });

    assert.equal(await new SodaBackend(mockOkRunner).isRepo("/x"), true);
  });
});

describe("resolveSelfUpdateBackend", () => {
  function statusRunner(initialized: boolean): SodaRunner {
    return async () => ({
      stdout: JSON.stringify({
        ok: true,
        command: "status",
        schemaVersion: 2,
        timingMs: 1,
        data: { summary: { repoRoot: "/x", initialized }, files: [] },
      }),
      stderr: "",
    });
  }

  it("selects the soda backend when the repo is soda-initialized", async () => {
    const backend = await resolveSelfUpdateBackend("/x", statusRunner(true));
    assert.ok(backend instanceof SodaBackend);
  });

  it("selects the git backend when the repo is only git (not soda-initialized)", async () => {
    const backend = await resolveSelfUpdateBackend("/x", statusRunner(false));
    assert.ok(backend instanceof GitBackend);
  });

  it("selects the git backend when the sd command is unavailable", async () => {
    const missingSd: SodaRunner = async () => {
      throw new Error("sd not found");
    };
    const backend = await resolveSelfUpdateBackend("/x", missingSd);
    assert.ok(backend instanceof GitBackend);
  });
});

describe("SodaBackend.publish", () => {
  it("runs the normal publish flow with the requested paths", async () => {
    const calls: string[][] = [];
    const runner = createMockRunner([
      { ok: true, data: { summary: { opened: 2, ahead: 0 }, files: [] } },
      { ok: true, data: { summary: { opened: 2, ahead: 0 }, files: [] } },
      { ok: true, data: { summary: { opened: 2, ahead: 0 }, files: [] } },
      { ok: true, data: { summary: { opened: 2, ahead: 0 }, files: [] } },
      { ok: true, data: { summary: { opened: 2, ahead: 0 }, files: [] } },
    ], calls);

    await new SodaBackend(runner).publish("/repo", ["src\\a.ts", "b.ts"], "msg");

    assert.deepEqual(calls, [
      ["status"],
      ["change", "rotunda"],
      ["reopen", "-c", "rotunda", "src/a.ts", "b.ts"],
      ["submit", "-c", "rotunda", "-d", "msg"],
      ["push"],
    ]);
  });

  it("recovers from a prior push by pushing only", async () => {
    const calls: string[][] = [];
    const runner = createMockRunner([
      { ok: true, data: { summary: { opened: 0, ahead: 1 }, files: [] } },
      { ok: true, data: { summary: { opened: 0, ahead: 1 }, files: [] } },
    ], calls);

    await new SodaBackend(runner).publish("/repo", ["src\\a.ts"], "msg");

    assert.deepEqual(calls, [["status"], ["push"]]);
  });

  it("propagates push failures", async () => {
    const calls: string[][] = [];
    const runner = createMockRunner([
      { ok: true, data: { summary: { opened: 2, ahead: 0 }, files: [] } },
      { ok: true, data: { status: "created" } },
      { ok: true, data: { status: "moved" } },
      { ok: true, data: { status: "submitted" } },
      { ok: false, error: "remote rejected" },
    ], calls);

    await assert.rejects(() => new SodaBackend(runner).publish("/repo", ["src\\a.ts"], "msg"), /push failed|remote rejected/);
    assert.deepEqual(calls, [["status"], ["change", "rotunda"], ["reopen", "-c", "rotunda", "src/a.ts"], ["submit", "-c", "rotunda", "-d", "msg"], ["push"]]);
  });
});

describe("SodaBackend.pull", () => {
  // `sd pull` returns `data` as an array of per-branch reconcile outcomes.
  // A pull only brings remote changes into the working tree when an outcome
  // advanced it, which soda reports via the `worktreeUpdated` flag.
  it("returns true when a branch fast-forwards and advances the worktree", async () => {
    const calls: string[][] = [];
    const runner = createMockRunner([
      { ok: true, data: [{ status: "fast-forward", branch: "main", upstream: "origin/main", worktreeUpdated: true }] },
    ], calls);

    assert.equal(await new SodaBackend(runner).pull("/repo"), true);
    assert.deepEqual(calls, [["pull"]]);
  });

  it("returns false when pull reports up to date", async () => {
    const calls: string[][] = [];
    const runner = createMockRunner([
      { ok: true, data: [{ status: "up-to-date", branch: "main", upstream: "origin/main", worktreeUpdated: false }] },
    ], calls);

    assert.equal(await new SodaBackend(runner).pull("/repo"), false);
    assert.deepEqual(calls, [["pull"]]);
  });

  it("returns false when the local branch is ahead (nothing fetched)", async () => {
    const calls: string[][] = [];
    const runner = createMockRunner([
      { ok: true, data: [{ status: "ahead", branch: "main", upstream: "origin/main", worktreeUpdated: false }] },
    ], calls);

    assert.equal(await new SodaBackend(runner).pull("/repo"), false);
    assert.deepEqual(calls, [["pull"]]);
  });

  it("propagates pull failures", async () => {
    const calls: string[][] = [];
    const runner = createMockRunner([
      { ok: false, error: "no upstream" },
    ], calls);

    await assert.rejects(() => new SodaBackend(runner).pull("/repo"), /pull failed|no upstream/);
    assert.deepEqual(calls, [["pull"]]);
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
