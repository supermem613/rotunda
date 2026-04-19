// Cross-platform test runner — expands glob and passes files to node --test
// Needed because Node 20's --test flag doesn't support glob patterns natively.
// Uses readdirSync + minimatch instead of fs.globSync (Node 22+ only).
//
// TENET: tests must be hermetic and produce identical results locally and in CI.
// To enforce that, this runner stubs HOME/USERPROFILE to a throwaway directory
// before spawning the test process, so any test that accidentally reads the
// developer's real ~/.rotunda.json (or any other dotfile) fails the same way
// it would in CI — where no such file exists. Without this, a developer's
// local state can silently mask a regression that only surfaces in CI.
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { minimatch } from "minimatch";
import { execSync } from "node:child_process";

const pattern = process.argv[2] || "test/**/*.test.ts";
const baseDir = pattern.split(/[/\\]/)[0] || ".";
const allFiles = readdirSync(baseDir, { recursive: true })
  .map((f) => join(baseDir, f).split("\\").join("/"))
  .filter((f) => minimatch(f, pattern));
const files = allFiles;

if (files.length === 0) {
  console.error(`No test files found matching: ${pattern}`);
  process.exit(1);
}

// Sandbox HOME so tests can't read the developer's real ~/.rotunda.json.
// Set ROTUNDA_TEST_REAL_HOME=1 to opt out (e.g., for ad-hoc debugging).
const sandboxHome = process.env.ROTUNDA_TEST_REAL_HOME
  ? null
  : mkdtempSync(join(tmpdir(), "rotunda-test-home-"));

const env = { ...process.env };
if (sandboxHome) {
  env.HOME = sandboxHome;
  env.USERPROFILE = sandboxHome;
}

const cmd = `node --import tsx --test ${files.join(" ")}`;
let exitCode = 0;
try {
  execSync(cmd, { stdio: "inherit", env });
} catch {
  exitCode = 1;
} finally {
  if (sandboxHome) {
    rmSync(sandboxHome, { recursive: true, force: true });
  }
}
process.exit(exitCode);
