// Cross-platform test runner — expands glob and passes files to node --test
// Needed because Node 20's --test flag doesn't support glob patterns natively.
// Uses readdirSync + minimatch instead of fs.globSync (Node 22+ only).
import { readdirSync } from "node:fs";
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

const cmd = `node --import tsx --test ${files.join(" ")}`;
try {
  execSync(cmd, { stdio: "inherit" });
} catch {
  process.exit(1);
}
