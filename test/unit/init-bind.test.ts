import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  saveGlobalConfig,
  loadGlobalConfig,
} from "../../src/core/config.js";
import { initCommand } from "../../src/commands/init.js";

/**
 * Init's binding policy:
 *   - No existing binding → init binds silently to cwd.
 *   - Existing binding to same path as cwd → no-op.
 *   - Existing binding to a different path → init does NOT overwrite; it
 *     warns and tells the user to run `rotunda bind` here to switch.
 */

const TMP_DIR = join(import.meta.dirname, "__init_bind_test_tmp__");

const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
const ORIG_CWD = process.cwd();

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
  // Use init's actual code path: create the dir, then chdir + run init.
  mkdirSync(dir, { recursive: true });
}

async function silently(fn: () => Promise<void>): Promise<void> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe("initCommand binding", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    setFakeHome(TMP_DIR);
  });

  afterEach(() => {
    process.chdir(ORIG_CWD);
    restoreHome();
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("binds to cwd when no binding exists", async () => {
    const repo = join(TMP_DIR, "fresh");
    makeRotundaRepo(repo);
    process.chdir(repo);

    await silently(() => initCommand());

    const configPath = join(TMP_DIR, ".rotunda.json");
    assert.equal(existsSync(configPath), true);
    assert.equal(loadGlobalConfig(configPath).dotfilesRepo, repo);
  });

  it("is a no-op when already bound to the same repo", async () => {
    const repo = join(TMP_DIR, "samerepo");
    makeRotundaRepo(repo);
    process.chdir(repo);
    const configPath = join(TMP_DIR, ".rotunda.json");
    saveGlobalConfig(
      { version: 1, dotfilesRepo: repo, cdShell: null },
      configPath,
    );

    await silently(() => initCommand());

    assert.equal(loadGlobalConfig(configPath).dotfilesRepo, repo);
  });

  it("does NOT overwrite an existing binding pointing elsewhere", async () => {
    const elsewhere = join(TMP_DIR, "elsewhere");
    makeRotundaRepo(elsewhere);
    writeFileSync(
      join(elsewhere, "rotunda.json"),
      JSON.stringify({ version: 1, roots: [], globalExclude: [] }),
    );

    const newRepo = join(TMP_DIR, "newrepo");
    makeRotundaRepo(newRepo);
    process.chdir(newRepo);

    const configPath = join(TMP_DIR, ".rotunda.json");
    saveGlobalConfig(
      { version: 1, dotfilesRepo: elsewhere, cdShell: null },
      configPath,
    );

    await silently(() => initCommand());

    // Binding stays on elsewhere — init refuses to silently switch.
    assert.equal(loadGlobalConfig(configPath).dotfilesRepo, elsewhere);
    // But init still ran (rotunda.json now exists in newRepo).
    assert.equal(existsSync(join(newRepo, "rotunda.json")), true);
  });
});
