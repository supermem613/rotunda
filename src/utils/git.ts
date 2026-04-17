import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a git command in the given directory.
 */
export async function git(
  args: string[],
  cwd: string
): Promise<GitResult> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (err: unknown) {
    const error = err as Error & { stdout?: string; stderr?: string; code?: number };
    // git diff --no-index exits with 1 when files differ — that's not an error
    if (args[0] === "diff" && error.code === 1) {
      return { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    }
    throw err;
  }
}

/**
 * Check if a directory is a git repository.
 */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--is-inside-work-tree"], dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the git status (porcelain) for specific paths.
 */
export async function gitStatus(
  cwd: string,
  paths: string[]
): Promise<string> {
  const result = await git(
    ["status", "--porcelain", ...paths],
    cwd
  );
  return result.stdout.trim();
}

/**
 * Stage, commit, and optionally push.
 */
export async function gitCommitAndPush(
  cwd: string,
  paths: string[],
  message: string,
  push = false
): Promise<void> {
  await git(["add", ...paths], cwd);
  await git(["commit", "-m", message], cwd);
  if (push) {
    await git(["push"], cwd);
  }
}

/**
 * Get a unified diff between two files using git diff --no-index.
 */
export async function gitDiffFiles(
  file1: string,
  file2: string,
  color = false
): Promise<string> {
  const args = ["diff", "--no-index"];
  if (color) args.push("--color");
  args.push("--", file1, file2);

  // git diff --no-index doesn't need a repo, cwd doesn't matter
  const result = await git(args, ".");
  return result.stdout;
}
