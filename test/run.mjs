// Cross-platform test runner — expands glob and passes files to node --test
// Needed because Node 20's --test flag doesn't support glob patterns natively.
import { globSync } from "node:fs";
import { execSync } from "node:child_process";

const pattern = process.argv[2] || "test/**/*.test.ts";
const files = globSync(pattern);

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
