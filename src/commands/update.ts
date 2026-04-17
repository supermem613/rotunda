import chalk from "chalk";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { git, isGitRepo } from "../utils/git.js";

const execAsync = promisify(exec);

export async function updateCommand(): Promise<void> {
  // Resolve the rotunda repo root from this file's location (dist/commands/update.js → repo root)
  const thisFile = fileURLToPath(import.meta.url);
  const repoRoot = dirname(dirname(dirname(thisFile)));

  console.log(chalk.dim(`  Rotunda repo: ${repoRoot}\n`));

  if (!(await isGitRepo(repoRoot))) {
    console.error(chalk.red("Error:") + " Rotunda install directory is not a git repo.");
    process.exit(1);
  }

  // 1. git pull
  console.log(chalk.bold("  ↓ Pulling latest..."));
  try {
    const result = await git(["pull", "--ff-only"], repoRoot);
    const output = (result.stdout + result.stderr).trim();
    if (output.includes("Already up to date")) {
      console.log(chalk.dim("    Already up to date."));
    } else {
      console.log(chalk.green("    ✓ Pulled new changes."));
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red("  ✗ git pull failed:") + ` ${msg}`);
    process.exit(1);
  }

  // 2. npm install
  console.log(chalk.bold("\n  ⬡ Installing dependencies..."));
  try {
    await execAsync("npm install --no-audit --no-fund", {
      cwd: repoRoot,
    });
    console.log(chalk.green("    ✓ Dependencies installed."));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red("  ✗ npm install failed:") + ` ${msg}`);
    process.exit(1);
  }

  // 3. npm run build
  console.log(chalk.bold("\n  🔨 Building..."));
  try {
    await execAsync("npm run build", {
      cwd: repoRoot,
    });
    console.log(chalk.green("    ✓ Build complete."));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red("  ✗ Build failed:") + ` ${msg}`);
    process.exit(1);
  }

  console.log(chalk.green("\n  ✓ Rotunda updated successfully."));
}
