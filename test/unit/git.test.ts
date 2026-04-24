import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  git,
  isGitRepo,
  gitPull,
  gitStatus,
  gitCommitAndPush,
  gitDiffFiles,
  formatSymlinkAwareDiff,
  renderContentDiff,
  renderSymlinkNotes,
  rewriteDiffPaths,
  type DiffSide,
  isPathIgnored,
} from "../../src/utils/git.js";

const TMP = join(tmpdir(), "rotunda-git-test");

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
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

function cleanup(): void {
  rmSync(TMP, { recursive: true, force: true });
}

function tryCreateFileSymlink(linkPath: string, targetPath: string): boolean {
  try {
    symlinkSync(targetPath, linkPath, "file");
    return true;
  } catch {
    return false;
  }
}

// --- isGitRepo ---

describe("isGitRepo", () => {
  beforeEach(() => rmSync(TMP, { recursive: true, force: true }));
  afterEach(cleanup);

  it("returns true for a git repository", async () => {
    const dir = join(TMP, "repo");
    initGitRepo(dir);
    assert.equal(await isGitRepo(dir), true);
  });

  it("returns false for a plain directory outside any repo", async () => {
    // Use OS temp dir to ensure we're outside the rotunda git repo
    const dir = join(tmpdir(), `rotunda-test-plain-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    try {
      assert.equal(await isGitRepo(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false for a nonexistent directory", async () => {
    assert.equal(await isGitRepo(join(TMP, "does-not-exist")), false);
  });

  it("returns false for a subdirectory nested inside another git repo", async () => {
    const outer = join(TMP, "outer-repo");
    initGitRepo(outer);
    const inner = join(outer, "subdir", "deep");
    mkdirSync(inner, { recursive: true });
    assert.equal(await isGitRepo(inner), false);
  });

  // These guard against the historic "passes locally, fails on the GitHub
  // Windows runner" bug where isGitRepo did a raw string compare against
  // `git rev-parse --show-toplevel`. Locally tmpdir() is already the long
  // form; on the runner it returns the 8.3 short path (RUNNER~1\...), so a
  // naive compare fails. These cases reproduce that mismatch on any host.

  it("returns true when dir has a trailing separator", async () => {
    const dir = join(TMP, "trailing-sep-repo");
    initGitRepo(dir);
    assert.equal(await isGitRepo(dir + sep), true);
  });

  if (process.platform === "win32") {
    it("returns true on Windows when dir casing differs from the real path", async () => {
      const dir = join(TMP, "cased-repo");
      initGitRepo(dir);
      assert.equal(await isGitRepo(dir.toUpperCase()), true);
    });
  }
});

// --- gitPull ---

describe("gitPull", () => {
  const BARE = join(TMP, "bare");
  const CLONE_A = join(TMP, "clone-a");
  const CLONE_B = join(TMP, "clone-b");

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });

    // Create bare remote with an initial commit
    initBareRepo(BARE);
    cloneRepo(BARE, CLONE_A);
    writeFileSync(join(CLONE_A, "seed.txt"), "initial");
    execFileSync("git", ["add", "."], { cwd: CLONE_A });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: CLONE_A });
    execFileSync("git", ["push"], { cwd: CLONE_A });

    // Clone B is the test subject
    cloneRepo(BARE, CLONE_B);
  });

  afterEach(cleanup);

  it("returns false when already up to date", async () => {
    const result = await gitPull(CLONE_B);
    assert.equal(result, false);
  });

  it("returns true when new changes are pulled", async () => {
    // Push a new commit from clone A
    writeFileSync(join(CLONE_A, "new-file.txt"), "hello");
    execFileSync("git", ["add", "."], { cwd: CLONE_A });
    execFileSync("git", ["commit", "-m", "add file"], { cwd: CLONE_A });
    execFileSync("git", ["push"], { cwd: CLONE_A });

    const result = await gitPull(CLONE_B);
    assert.equal(result, true);

    // Verify the file arrived
    const content = readFileSync(join(CLONE_B, "new-file.txt"), "utf-8");
    assert.equal(content, "hello");
  });

  it("throws when history has diverged (ff-only fails)", async () => {
    // Create divergent commits in both clones
    writeFileSync(join(CLONE_A, "file.txt"), "from A");
    execFileSync("git", ["add", "."], { cwd: CLONE_A });
    execFileSync("git", ["commit", "-m", "commit A"], { cwd: CLONE_A });
    execFileSync("git", ["push"], { cwd: CLONE_A });

    writeFileSync(join(CLONE_B, "file.txt"), "from B");
    execFileSync("git", ["add", "."], { cwd: CLONE_B });
    execFileSync("git", ["commit", "-m", "commit B"], { cwd: CLONE_B });

    await assert.rejects(() => gitPull(CLONE_B));
  });

  it("throws when there is no remote configured", async () => {
    const standalone = join(TMP, "standalone");
    initGitRepo(standalone);
    writeFileSync(join(standalone, "file.txt"), "x");
    execFileSync("git", ["add", "."], { cwd: standalone });
    execFileSync("git", ["commit", "-m", "init"], { cwd: standalone });

    await assert.rejects(() => gitPull(standalone));
  });
});

// --- gitStatus ---

describe("gitStatus", () => {
  const REPO = join(TMP, "status-repo");

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    initGitRepo(REPO);
    writeFileSync(join(REPO, "tracked.txt"), "original");
    execFileSync("git", ["add", "."], { cwd: REPO });
    execFileSync("git", ["commit", "-m", "init"], { cwd: REPO });
  });

  afterEach(cleanup);

  it("returns empty string for clean working tree", async () => {
    const status = await gitStatus(REPO, ["."]);
    assert.equal(status, "");
  });

  it("reports modified files", async () => {
    writeFileSync(join(REPO, "tracked.txt"), "changed");
    const status = await gitStatus(REPO, ["."]);
    assert.ok(status.includes("tracked.txt"));
    assert.ok(status.includes("M"));
  });

  it("reports untracked files", async () => {
    writeFileSync(join(REPO, "newfile.txt"), "new");
    const status = await gitStatus(REPO, ["."]);
    assert.ok(status.includes("newfile.txt"));
    assert.ok(status.includes("?"));
  });
});

// --- gitCommitAndPush ---

describe("gitCommitAndPush", () => {
  const REPO = join(TMP, "commit-repo");

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    initGitRepo(REPO);
    writeFileSync(join(REPO, "init.txt"), "seed");
    execFileSync("git", ["add", "."], { cwd: REPO });
    execFileSync("git", ["commit", "-m", "seed"], { cwd: REPO });
  });

  afterEach(cleanup);

  it("stages and commits specified files", async () => {
    writeFileSync(join(REPO, "a.txt"), "aaa");
    writeFileSync(join(REPO, "b.txt"), "bbb");

    await gitCommitAndPush(REPO, ["a.txt", "b.txt"], "add two files", false);

    // Verify commit exists
    const log = execFileSync("git", ["log", "--oneline", "-1"], { cwd: REPO }).toString();
    assert.ok(log.includes("add two files"));

    // Verify working tree is clean
    const status = await gitStatus(REPO, ["."]);
    assert.equal(status, "");
  });

  it("only stages specified paths, not other dirty files", async () => {
    writeFileSync(join(REPO, "staged.txt"), "yes");
    writeFileSync(join(REPO, "unstaged.txt"), "no");

    await gitCommitAndPush(REPO, ["staged.txt"], "partial commit", false);

    // unstaged.txt should still be untracked
    const status = await gitStatus(REPO, ["."]);
    assert.ok(status.includes("unstaged.txt"), "unstaged.txt should remain untracked");

    // Verify staged.txt is tracked and clean by checking git show
    const show = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: REPO,
    }).toString().trim();
    assert.ok(show.includes("staged.txt"), "staged.txt should be in the commit");
  });

  it("recovers from CRLF-safe staging errors with one-off git config only", async () => {
    execFileSync("git", ["config", "--local", "core.autocrlf", "true"], { cwd: REPO });
    execFileSync("git", ["config", "--local", "core.safecrlf", "true"], { cwd: REPO });
    writeFileSync(join(REPO, "lf-only.txt"), "one\ntwo\n");

    await gitCommitAndPush(REPO, ["lf-only.txt"], "commit lf file", false);

    const log = execFileSync("git", ["log", "--oneline", "-1"], { cwd: REPO }).toString();
    assert.ok(log.includes("commit lf file"));
    const repoAutocrlf = execFileSync("git", ["config", "--local", "--get", "core.autocrlf"], {
      cwd: REPO,
    }).toString().trim();
    const repoSafecrlf = execFileSync("git", ["config", "--local", "--get", "core.safecrlf"], {
      cwd: REPO,
    }).toString().trim();
    assert.equal(repoAutocrlf, "true");
    assert.equal(repoSafecrlf, "true");
  });
});

// --- isPathIgnored ---

describe("isPathIgnored", () => {
  const REPO = join(TMP, "ignore-repo");

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    initGitRepo(REPO);
  });

  afterEach(cleanup);

  it("returns true for a path ignored by .gitignore", async () => {
    writeFileSync(join(REPO, ".gitignore"), ".rotunda/\n");
    assert.equal(await isPathIgnored(".rotunda/state.json", REPO), true);
  });

  it("returns true for a directory pattern when probing a child file", async () => {
    writeFileSync(join(REPO, ".gitignore"), "build/\n");
    assert.equal(await isPathIgnored("build/output.js", REPO), true);
  });

  it("returns false for a path not matched by any ignore rule", async () => {
    writeFileSync(join(REPO, ".gitignore"), "node_modules/\n");
    assert.equal(await isPathIgnored("src/index.ts", REPO), false);
  });

  it("returns false when .gitignore is empty/absent", async () => {
    assert.equal(await isPathIgnored(".rotunda/state.json", REPO), false);
  });

  it("returns false for a non-git directory rather than throwing", async () => {
    const plain = join(tmpdir(), `rotunda-test-noignore-${process.pid}`);
    mkdirSync(plain, { recursive: true });
    try {
      assert.equal(await isPathIgnored("anything", plain), false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("respects negation patterns", async () => {
    // Note: gitignore can only negate files/dirs whose PARENT is not ignored.
    // Use file glob (not dir) so negation actually applies.
    writeFileSync(join(REPO, ".gitignore"), "*.log\n!keep.log\n");
    assert.equal(await isPathIgnored("other.log", REPO), true);
    assert.equal(await isPathIgnored("keep.log", REPO), false);
  });
});

// --- gitDiffFiles ---

describe("gitDiffFiles", () => {
  beforeEach(() => rmSync(TMP, { recursive: true, force: true }));
  afterEach(cleanup);

  it("returns diff output for different files", async () => {
    mkdirSync(TMP, { recursive: true });
    const f1 = join(TMP, "old.txt");
    const f2 = join(TMP, "new.txt");
    writeFileSync(f1, "line one\n");
    writeFileSync(f2, "line two\n");

    const diff = await gitDiffFiles(f1, f2);
    assert.ok(diff.length > 0, "diff should not be empty");
    assert.ok(diff.includes("-line one"), "diff should show removed line");
    assert.ok(diff.includes("+line two"), "diff should show added line");
  });

  it("returns empty string for identical files", async () => {
    mkdirSync(TMP, { recursive: true });
    const f1 = join(TMP, "same1.txt");
    const f2 = join(TMP, "same2.txt");
    writeFileSync(f1, "same content\n");
    writeFileSync(f2, "same content\n");

    const diff = await gitDiffFiles(f1, f2);
    assert.equal(diff, "");
  });
});

describe("renderContentDiff", () => {
  beforeEach(() => rmSync(TMP, { recursive: true, force: true }));
  afterEach(cleanup);

  it("renders dereferenced content for a local symlink without file mode noise", async (t) => {
    mkdirSync(TMP, { recursive: true });
    const repoFile = join(TMP, "repo-claude.md");
    const authorityFile = join(TMP, "copilot-instructions.md");
    const localLink = join(TMP, "CLAUDE.md");

    writeFileSync(repoFile, "repo line\nshared\n");
    writeFileSync(authorityFile, "local line\nshared\n");
    if (!tryCreateFileSymlink(localLink, authorityFile)) {
      t.skip("file symlink creation is not available in this environment");
      return;
    }

    const diff = await renderContentDiff(repoFile, localLink, {
      file1Role: "repo",
      file2Role: "local",
    });

    assert.ok(diff.includes("(local is symlink ->"), diff);
    assert.ok(diff.includes(repoFile), diff);
    assert.ok(diff.includes(localLink), diff);
    assert.ok(diff.includes("-repo line"), diff);
    assert.ok(diff.includes("+local line"), diff);
    assert.ok(!diff.includes("deleted file mode"), diff);
    assert.ok(!diff.includes("new file mode 120000"), diff);
    assert.ok(!diff.includes("rotunda-diff-"), diff);
  });

  it("renders dereferenced content for a repo symlink and annotates the repo side", async (t) => {
    mkdirSync(TMP, { recursive: true });
    const repoAuthority = join(TMP, "repo-authority.md");
    const repoLink = join(TMP, "repo-link.md");
    const localFile = join(TMP, "local-file.md");

    writeFileSync(repoAuthority, "repo authoritative\n");
    writeFileSync(localFile, "local authoritative\n");
    if (!tryCreateFileSymlink(repoLink, repoAuthority)) {
      t.skip("file symlink creation is not available in this environment");
      return;
    }

    const diff = await renderContentDiff(repoLink, localFile, {
      file1Role: "repo",
      file2Role: "local",
    });

    assert.ok(diff.includes("(repo is symlink ->"), diff);
    assert.ok(diff.includes(repoLink), diff);
    assert.ok(diff.includes(localFile), diff);
    assert.ok(diff.includes("-repo authoritative"), diff);
    assert.ok(diff.includes("+local authoritative"), diff);
    assert.ok(!diff.includes("deleted file mode"), diff);
    assert.ok(!diff.includes("new file mode 120000"), diff);
    assert.ok(!diff.includes("rotunda-diff-"), diff);
  });
});

describe("symlink diff formatting helpers", () => {
  it("renders symlink notes with normalized targets", () => {
    const sides: DiffSide[] = [
      {
        path: "C:\\repo\\file.txt",
        role: "local",
        isSymlink: true,
        target: "C:/authority/file.txt",
      },
      {
        path: "C:\\repo\\other.txt",
        role: "repo",
        isSymlink: false,
      },
    ];

    assert.deepEqual(renderSymlinkNotes(sides), [
      "  (local is symlink -> C:/authority/file.txt)",
    ]);
  });

  it("rewrites raw, escaped, and slash-normalized temp paths in diff headers", () => {
    const diff = [
      'diff --git "a/C:\\\\Temp\\\\rotunda-diff-abc\\\\left" "b/C:/Temp/rotunda-diff-abc/right"',
      '--- "a/C:\\Temp\\rotunda-diff-abc\\left"',
      '+++ "b/C:\\\\Temp\\\\rotunda-diff-abc\\\\right"',
    ].join("\n");

    const rewritten = rewriteDiffPaths(diff, [
      { from: "C:\\Temp\\rotunda-diff-abc\\left", to: "C:\\repo\\left.txt" },
      { from: "C:\\Temp\\rotunda-diff-abc\\right", to: "C:\\repo\\right.txt" },
    ]);

    assert.ok(rewritten.includes('diff --git "a/C:\\repo\\left.txt" "b/C:\\repo\\right.txt"'), rewritten);
    assert.ok(rewritten.includes('--- "a/C:\\repo\\left.txt"'), rewritten);
    assert.ok(rewritten.includes('+++ "b/C:\\repo\\right.txt"'), rewritten);
    assert.ok(!rewritten.includes("rotunda-diff-abc"), rewritten);
  });

  it("combines symlink notes with rewritten diff output", () => {
    const sides: DiffSide[] = [
      { path: "C:\\repo\\linked.txt", role: "local", isSymlink: true, target: "C:/authority/linked.txt" },
      { path: "C:\\repo\\repo.txt", role: "repo", isSymlink: false },
    ];
    const diff = 'diff --git "a/C:\\\\tmp\\\\left" "b/C:\\\\tmp\\\\right"\n-line one\n+line two\n';

    const formatted = formatSymlinkAwareDiff(diff, sides, [
      { from: "C:\\tmp\\left", to: "C:\\repo\\repo.txt" },
      { from: "C:\\tmp\\right", to: "C:\\repo\\linked.txt" },
    ]);

    assert.ok(formatted.startsWith("  (local is symlink -> C:/authority/linked.txt)"), formatted);
    assert.ok(formatted.includes('diff --git "a/C:\\repo\\repo.txt" "b/C:\\repo\\linked.txt"'), formatted);
    assert.ok(formatted.includes("-line one"), formatted);
    assert.ok(formatted.includes("+line two"), formatted);
  });

  it("returns notes only when symlink-aware content diff is otherwise empty", () => {
    const sides: DiffSide[] = [
      { path: "C:\\repo\\linked.txt", role: "repo", isSymlink: true, target: "C:/authority/linked.txt" },
      { path: "C:\\repo\\local.txt", role: "local", isSymlink: false },
    ];

    const formatted = formatSymlinkAwareDiff("", sides, []);

    assert.equal(formatted, "  (repo is symlink -> C:/authority/linked.txt)");
  });
});

// --- git (low-level) ---

describe("git helper", () => {
  const REPO = join(TMP, "git-helper-repo");

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    initGitRepo(REPO);
  });

  afterEach(cleanup);

  it("returns stdout and stderr from git commands", async () => {
    const result = await git(["status"], REPO);
    assert.ok(typeof result.stdout === "string");
    assert.ok(typeof result.stderr === "string");
  });

  it("throws for invalid git commands", async () => {
    await assert.rejects(() => git(["not-a-real-command"], REPO));
  });
});
