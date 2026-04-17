/**
 * Shared boilerplate for command entry points.
 *
 * Most commands need the same prelude: resolve the bound dotfiles repo,
 * load its manifest, and exit gracefully on RotundaError. Extracting that
 * into one helper keeps each command focused on its actual job.
 */

import chalk from "chalk";
import { loadManifest, RotundaError } from "./manifest.js";
import type { Manifest } from "./types.js";
import { resolveRepoRoot } from "./config.js";

export interface RepoContext {
  cwd: string;
  manifest: Manifest;
}

/**
 * Resolve the bound repo and load its manifest.
 *
 * On any RotundaError (no binding, missing path, missing manifest, etc.)
 * prints a red "Error:" line to stderr and exits with code 1. Other
 * errors propagate so they're not silently swallowed.
 *
 * Use at the top of any command that needs a manifest:
 *   const { cwd, manifest } = loadRepoContext();
 */
export function loadRepoContext(): RepoContext {
  try {
    const cwd = resolveRepoRoot();
    const manifest = loadManifest(cwd);
    return { cwd, manifest };
  } catch (err) {
    if (err instanceof RotundaError) {
      console.error(chalk.red("Error:") + " " + err.message);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Like loadRepoContext but only resolves the repo path (no manifest load).
 * For commands like `where` and `cd` that don't need the manifest.
 */
export function resolveRepoOrExit(): string {
  try {
    return resolveRepoRoot();
  } catch (err) {
    if (err instanceof RotundaError) {
      console.error(chalk.red("Error:") + " " + err.message);
      process.exit(1);
    }
    throw err;
  }
}
