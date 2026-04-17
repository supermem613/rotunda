import chalk from "chalk";
import { resolveRepoRoot } from "../core/config.js";
import { RotundaError } from "../core/manifest.js";

/**
 * `rotunda where` — print the resolved dotfiles repo path.
 *
 * Designed for shell composition: `cd (rotunda where)` (PowerShell) or
 * `cd $(rotunda where)` (bash/zsh). Prints exactly the path with a single
 * trailing newline; nothing else on stdout.
 *
 * Exit code 0 on success, 1 on any resolution failure (with a helpful
 * message on stderr).
 */
export function whereCommand(): void {
  try {
    const path = resolveRepoRoot();
    process.stdout.write(path + "\n");
  } catch (err) {
    const msg = err instanceof RotundaError ? err.message : String(err);
    console.error(chalk.red("Error:") + " " + msg);
    process.exit(1);
  }
}
