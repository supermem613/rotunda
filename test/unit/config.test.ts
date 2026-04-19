import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  loadGlobalConfig,
  saveGlobalConfig,
  resolveRepoRoot,
  expandUserPath,
  pickShell,
  getGlobalConfigPath,
  GlobalConfigSchema,
} from "../../src/core/config.js";
import { RotundaError } from "../../src/core/manifest.js";

const TMP_DIR = join(tmpdir(), "rotunda-config-test");
const CONFIG_PATH = join(TMP_DIR, ".rotunda.json");
const REPO_DIR = join(TMP_DIR, "dotfiles");

function makeRotundaRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "rotunda.json"),
    JSON.stringify({ version: 1, roots: [], globalExclude: [] }),
  );
}

describe("getGlobalConfigPath", () => {
  it("returns ~/.rotunda.json (homedir-based)", () => {
    const path = getGlobalConfigPath();
    assert.equal(path, join(homedir(), ".rotunda.json"));
  });
});

describe("GlobalConfigSchema", () => {
  it("accepts a minimal valid config (cdShell defaults to null)", () => {
    const result = GlobalConfigSchema.parse({
      version: 1,
      dotfilesRepo: "/tmp/foo",
    });
    assert.equal(result.cdShell, null);
  });

  it("rejects an unsupported version", () => {
    const result = GlobalConfigSchema.safeParse({
      version: 2,
      dotfilesRepo: null,
    });
    assert.equal(result.success, false);
  });

  it("accepts dotfilesRepo: null", () => {
    const result = GlobalConfigSchema.parse({
      version: 1,
      dotfilesRepo: null,
      cdShell: null,
    });
    assert.equal(result.dotfilesRepo, null);
  });

  it("accepts cdShell as a string override", () => {
    const result = GlobalConfigSchema.parse({
      version: 1,
      dotfilesRepo: null,
      cdShell: "pwsh",
    });
    assert.equal(result.cdShell, "pwsh");
  });
});

describe("loadGlobalConfig", () => {
  beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  it("returns an empty config when the file doesn't exist", () => {
    const config = loadGlobalConfig(CONFIG_PATH);
    assert.equal(config.version, 1);
    assert.equal(config.dotfilesRepo, null);
    assert.equal(config.cdShell, null);
  });

  it("parses a valid config from disk", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ version: 1, dotfilesRepo: "/foo", cdShell: null }),
    );
    const config = loadGlobalConfig(CONFIG_PATH);
    assert.equal(config.dotfilesRepo, "/foo");
  });

  it("throws RotundaError on invalid JSON", () => {
    writeFileSync(CONFIG_PATH, "not json {");
    assert.throws(
      () => loadGlobalConfig(CONFIG_PATH),
      (err: Error) => err instanceof RotundaError && /Invalid JSON/.test(err.message),
    );
  });

  it("throws RotundaError on schema mismatch", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ version: 99, dotfilesRepo: "/x" }),
    );
    assert.throws(
      () => loadGlobalConfig(CONFIG_PATH),
      (err: Error) => err instanceof RotundaError && /Invalid config/.test(err.message),
    );
  });

  it("throws RotundaError when dotfilesRepo is missing entirely", () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ version: 1 }));
    assert.throws(
      () => loadGlobalConfig(CONFIG_PATH),
      (err: Error) => err instanceof RotundaError,
    );
  });
});

describe("saveGlobalConfig", () => {
  beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  it("writes the config to disk", () => {
    saveGlobalConfig(
      { version: 1, dotfilesRepo: "/foo/bar", cdShell: null },
      CONFIG_PATH,
    );
    assert.equal(existsSync(CONFIG_PATH), true);
    const written = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    assert.equal(written.dotfilesRepo, "/foo/bar");
  });

  it("creates the parent directory if missing", () => {
    const nested = join(TMP_DIR, "nested", "deep", ".rotunda.json");
    saveGlobalConfig(
      { version: 1, dotfilesRepo: null, cdShell: null },
      nested,
    );
    assert.equal(existsSync(nested), true);
  });

  it("survives a load → save → load round-trip", () => {
    const config = { version: 1 as const, dotfilesRepo: "/x", cdShell: "bash" };
    saveGlobalConfig(config, CONFIG_PATH);
    const reloaded = loadGlobalConfig(CONFIG_PATH);
    assert.deepStrictEqual(reloaded, config);
  });

  it("trailing newline is present (POSIX hygiene)", () => {
    saveGlobalConfig(
      { version: 1, dotfilesRepo: null, cdShell: null },
      CONFIG_PATH,
    );
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    assert.equal(raw.endsWith("\n"), true);
  });
});

describe("resolveRepoRoot", () => {
  beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  it("returns the bound path when valid", () => {
    makeRotundaRepo(REPO_DIR);
    saveGlobalConfig(
      { version: 1, dotfilesRepo: REPO_DIR, cdShell: null },
      CONFIG_PATH,
    );
    assert.equal(resolveRepoRoot(CONFIG_PATH), REPO_DIR);
  });

  it("throws when no binding is set", () => {
    saveGlobalConfig(
      { version: 1, dotfilesRepo: null, cdShell: null },
      CONFIG_PATH,
    );
    assert.throws(
      () => resolveRepoRoot(CONFIG_PATH),
      (err: Error) =>
        err instanceof RotundaError && /No dotfiles repo bound/.test(err.message),
    );
  });

  it("throws when no config file exists at all", () => {
    assert.throws(
      () => resolveRepoRoot(CONFIG_PATH),
      (err: Error) =>
        err instanceof RotundaError && /No dotfiles repo bound/.test(err.message),
    );
  });

  it("throws when the bound path no longer exists", () => {
    saveGlobalConfig(
      { version: 1, dotfilesRepo: join(TMP_DIR, "ghost"), cdShell: null },
      CONFIG_PATH,
    );
    assert.throws(
      () => resolveRepoRoot(CONFIG_PATH),
      (err: Error) =>
        err instanceof RotundaError && /no longer exists/.test(err.message),
    );
  });

  it("throws when the bound path exists but has no rotunda.json", () => {
    mkdirSync(REPO_DIR, { recursive: true });
    saveGlobalConfig(
      { version: 1, dotfilesRepo: REPO_DIR, cdShell: null },
      CONFIG_PATH,
    );
    assert.throws(
      () => resolveRepoRoot(CONFIG_PATH),
      (err: Error) =>
        err instanceof RotundaError && /not a rotunda repo/.test(err.message),
    );
  });

  it("error message instructs how to recover (bind suggestion)", () => {
    assert.throws(
      () => resolveRepoRoot(CONFIG_PATH),
      (err: Error) => /rotunda bind/.test(err.message),
    );
  });
});

describe("expandUserPath", () => {
  it("expands ~ to homedir", () => {
    assert.equal(expandUserPath("~"), homedir());
  });

  it("expands ~/foo to homedir/foo", () => {
    assert.equal(expandUserPath("~/foo"), join(homedir(), "foo"));
  });

  it("expands ~\\foo on Windows-style paths", () => {
    assert.equal(expandUserPath("~\\foo"), join(homedir(), "foo"));
  });

  it("leaves absolute paths unchanged", () => {
    const abs = process.platform === "win32" ? "C:\\abs\\path" : "/abs/path";
    assert.equal(expandUserPath(abs), abs);
  });

  it("resolves relative paths against the provided base", () => {
    const base = process.platform === "win32" ? "C:\\base" : "/base";
    const expected =
      process.platform === "win32" ? "C:\\base\\rel" : "/base/rel";
    assert.equal(expandUserPath("rel", base), expected);
  });
});

describe("pickShell", () => {
  it("honors an explicit cdShell verbatim", () => {
    const result = pickShell("/usr/bin/fish");
    assert.equal(result.cmd, "/usr/bin/fish");
    assert.deepStrictEqual(result.args, []);
  });

  it("returns a shell command for the current platform when no override", () => {
    const result = pickShell(null);
    assert.equal(typeof result.cmd, "string");
    assert.notEqual(result.cmd.length, 0);
    assert.equal(Array.isArray(result.args), true);
  });

  it("on Windows, falls back to ComSpec/cmd.exe at minimum", () => {
    if (process.platform !== "win32") return; // skip on non-Windows
    const result = pickShell(null);
    // Whatever it picks, it should be one of pwsh/powershell/cmd.exe.
    assert.match(result.cmd, /pwsh|powershell|cmd\.exe$/i);
  });

  it("on Unix, returns $SHELL or /bin/sh", () => {
    if (process.platform === "win32") return; // skip on Windows
    const result = pickShell(null);
    assert.equal(result.cmd, process.env.SHELL || "/bin/sh");
  });
});
