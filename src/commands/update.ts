import chalk from "chalk";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { git, isGitRepo } from "../utils/git.js";

const execAsync = promisify(exec);

type ExecResult = {
  stdout: string;
  stderr: string;
};

export type UpdateDeps = {
  repoRoot?: string;
  isGitRepo?: (dir: string) => Promise<boolean>;
  runGit?: (args: string[], cwd: string) => Promise<ExecResult>;
  runCommand?: (command: string, cwd: string) => Promise<void>;
};

export function gitPullMadeNoChanges(output: string): boolean {
  return /already up[- ]to[- ]date\.?/i.test(output);
}

async function defaultRunCommand(command: string, cwd: string): Promise<void> {
  await execAsync(command, { cwd });
}

export async function updateCommand(deps: UpdateDeps = {}): Promise<void> {
  // Resolve the rotunda repo root from this file's location (dist/commands/update.js → repo root)
  const thisFile = fileURLToPath(import.meta.url);
  const repoRoot = deps.repoRoot ?? dirname(dirname(dirname(thisFile)));
  const checkGitRepo = deps.isGitRepo ?? isGitRepo;
  const runGit = deps.runGit ?? git;
  const runCommand = deps.runCommand ?? defaultRunCommand;

  console.log(chalk.dim(`  Rotunda repo: ${repoRoot}\n`));

  if (!(await checkGitRepo(repoRoot))) {
    console.error(chalk.red("Error:") + " Rotunda install directory is not a git repo.");
    process.exit(1);
  }

  // 1. git pull
  console.log(chalk.bold("  ↓ Pulling latest..."));
  try {
    const result = await runGit(["pull", "--ff-only"], repoRoot);
    const output = (result.stdout + result.stderr).trim();
    if (gitPullMadeNoChanges(output)) {
      console.log(chalk.dim("    Already up to date."));
      console.log(chalk.dim("    Skipping install and build."));
      return;
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
    await runCommand("npm install --no-audit --no-fund", repoRoot);
    console.log(chalk.green("    ✓ Dependencies installed."));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red("  ✗ npm install failed:") + ` ${msg}`);
    process.exit(1);
  }

  // 3. npm run build
  console.log(chalk.bold("\n  🔨 Building..."));
  try {
    await runCommand("npm run build", repoRoot);
    console.log(chalk.green("    ✓ Build complete."));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red("  ✗ Build failed:") + ` ${msg}`);
    process.exit(1);
  }

  console.log(chalk.green("\n  ✓ Rotunda updated successfully."));
}
