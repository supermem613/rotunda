import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { saveGlobalConfig, loadGlobalConfig } from "../../src/core/config.js";
import { whereCommand } from "../../src/commands/where.js";

const TMP_DIR = join(import.meta.dirname, "__bind_test_tmp__");

/**
 * The bind/where commands read ~/.rotunda.json directly via getGlobalConfigPath().
 * To exercise them end-to-end we redirect the user's home to a tmp dir for the
 * duration of each test by overriding HOME (Unix) and USERPROFILE (Windows)
 * before calling the command. os.homedir() consults these env vars on each
 * call in current Node, so this works without monkeypatching.
 */

const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;

function setFakeHome(dir: string): void {
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}

function restoreHome(): void {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIG_USERPROFILE;
}

function makeRotundaRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "rotunda.json"),
    JSON.stringify({ version: 1, roots: [], globalExclude: [] }),
  );
}

/** Capture stdout for a single function call. */
async function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  let buf = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    buf += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return buf;
}

describe("bindCommand", () => {
  let configPath: string;

  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    setFakeHome(TMP_DIR);
    configPath = join(TMP_DIR, ".rotunda.json");
  });

  afterEach(() => {
    restoreHome();
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("binds to a given path containing rotunda.json", async () => {
    const repo = join(TMP_DIR, "repo");
    makeRotundaRepo(repo);
    const { bindCommand } = await import("../../src/commands/bind.js");

    await bindCommand(repo, {});

    const config = loadGlobalConfig(configPath);
    assert.equal(config.dotfilesRepo, repo);
  });

  it("binds to cwd when no path is given", async () => {
    const repo = join(TMP_DIR, "cwdrepo");
    makeRotundaRepo(repo);
    const origCwd = process.cwd();
    process.chdir(repo);
    try {
      const { bindCommand } = await import("../../src/commands/bind.js");
      await bindCommand(undefined, {});
      const config = loadGlobalConfig(configPath);
      assert.equal(config.dotfilesRepo, repo);
    } finally {
      process.chdir(origCwd);
    }
  });

  it("expands ~/path correctly", async () => {
    const repoName = "tilderepo";
    const repo = join(TMP_DIR, repoName);
    makeRotundaRepo(repo);
    const { bindCommand } = await import("../../src/commands/bind.js");

    await bindCommand(`~/${repoName}`, {});

    const config = loadGlobalConfig(configPath);
    assert.equal(config.dotfilesRepo, repo);
  });

  it("--unset removes an existing binding", async () => {
    const repo = join(TMP_DIR, "repo");
    makeRotundaRepo(repo);
    saveGlobalConfig(
      { version: 1, dotfilesRepo: repo, cdShell: null },
      configPath,
    );
    const { bindCommand } = await import("../../src/commands/bind.js");

    await bindCommand(undefined, { unset: true });

    assert.equal(loadGlobalConfig(configPath).dotfilesRepo, null);
  });

  it("--unset is a no-op when nothing is bound", async () => {
    const { bindCommand } = await import("../../src/commands/bind.js");
    // Should not throw or write anything weird.
    await bindCommand(undefined, { unset: true });
    assert.equal(loadGlobalConfig(configPath).dotfilesRepo, null);
  });

  it("--show prints the current binding", async () => {
    const repo = join(TMP_DIR, "repo");
    makeRotundaRepo(repo);
    saveGlobalConfig(
      { version: 1, dotfilesRepo: repo, cdShell: null },
      configPath,
    );
    const { bindCommand } = await import("../../src/commands/bind.js");

    const out = await captureStdout(() => bindCommand(undefined, { show: true }));
    assert.match(out, new RegExp(repo.replace(/\\/g, "\\\\")));
  });

  it("--show prints '(no binding)' when unbound", async () => {
    const { bindCommand } = await import("../../src/commands/bind.js");
    const out = await captureStdout(() => bindCommand(undefined, { show: true }));
    assert.match(out, /no binding/i);
  });

  it("rejects binding to a path that doesn't exist", async () => {
    const ghost = join(TMP_DIR, "ghost");
    const { bindCommand } = await import("../../src/commands/bind.js");

    // bindCommand calls process.exit(1) on error — intercept it.
    let exitCode: number | null = null;
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error("__exit__");
    }) as typeof process.exit;
    try {
      await bindCommand(ghost, {}).catch((e) => {
        if (e.message !== "__exit__") throw e;
      });
    } finally {
      process.exit = origExit;
    }

    assert.equal(exitCode, 1);
    assert.equal(loadGlobalConfig(configPath).dotfilesRepo, null);
  });

  it("rejects binding to a path with no rotunda.json", async () => {
    const dir = join(TMP_DIR, "notarepo");
    mkdirSync(dir, { recursive: true });
    const { bindCommand } = await import("../../src/commands/bind.js");

    let exitCode: number | null = null;
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error("__exit__");
    }) as typeof process.exit;
    try {
      await bindCommand(dir, {}).catch((e) => {
        if (e.message !== "__exit__") throw e;
      });
    } finally {
      process.exit = origExit;
    }

    assert.equal(exitCode, 1);
  });

  it("re-binding to a different repo overwrites the previous binding", async () => {
    const repoA = join(TMP_DIR, "a");
    const repoB = join(TMP_DIR, "b");
    makeRotundaRepo(repoA);
    makeRotundaRepo(repoB);
    const { bindCommand } = await import("../../src/commands/bind.js");

    await bindCommand(repoA, {});
    assert.equal(loadGlobalConfig(configPath).dotfilesRepo, repoA);

    await bindCommand(repoB, {});
    assert.equal(loadGlobalConfig(configPath).dotfilesRepo, repoB);
  });
});

describe("whereCommand", () => {
  let configPath: string;

  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    setFakeHome(TMP_DIR);
    configPath = join(TMP_DIR, ".rotunda.json");
  });

  afterEach(() => {
    restoreHome();
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("prints the bound path with a single trailing newline", async () => {
    const repo = join(TMP_DIR, "repo");
    makeRotundaRepo(repo);
    saveGlobalConfig(
      { version: 1, dotfilesRepo: repo, cdShell: null },
      configPath,
    );

    const out = await captureStdout(() => whereCommand());
    assert.equal(out, repo + "\n");
  });

  it("exits 1 when nothing is bound", async () => {
    let exitCode: number | null = null;
    const origExit = process.exit;
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error("__exit__");
    }) as typeof process.exit;
    try {
      try {
        whereCommand();
      } catch (e) {
        if ((e as Error).message !== "__exit__") throw e;
      }
    } finally {
      process.exit = origExit;
      process.stderr.write = origStderr;
    }
    assert.equal(exitCode, 1);
  });
});
