import { gitCommitAndPush, gitPull, isGitRepo } from "./git.js";

/**
 * Publish is one atomic verb (stage + commit + push), not separate git steps,
 * to prevent over-commit leakage in future backends.
 */
export interface VcsBackend {
  isRepo(cwd: string): Promise<boolean>;
  pull(cwd: string): Promise<boolean>;
  publish(cwd: string, paths: string[], message: string): Promise<void>;
}

export class GitBackend implements VcsBackend {
  async isRepo(cwd: string): Promise<boolean> {
    return isGitRepo(cwd);
  }

  async pull(cwd: string): Promise<boolean> {
    return gitPull(cwd);
  }

  async publish(cwd: string, paths: string[], message: string): Promise<void> {
    await gitCommitAndPush(cwd, paths, message, true);
  }
}

export function resolveBackend(cwd: string): VcsBackend {
  void cwd;
  return new GitBackend();
}
