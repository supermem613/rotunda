import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import {
  loadGlobalConfig,
  saveGlobalConfig,
  expandUserPath,
  getGlobalConfigPath,
} from "../core/config.js";

interface BindOptions {
  unset?: boolean;
  show?: boolean;
}

/**
 * `rotunda bind [path]` — manage the persistent dotfiles-repo binding.
 *
 * Modes:
 *   rotunda bind            → bind to current working directory
 *   rotunda bind <path>     → bind to a specific path
 *   rotunda bind --unset    → remove the binding
 *   rotunda bind --show     → print the current binding (no mutation)
 *
 * `bind` is the *only* way to mutate the binding once one exists. `init`
 * deliberately won't overwrite an existing binding; users must run `bind`
 * explicitly to switch.
 */
export async function bindCommand(
  pathArg: string | undefined,
  options: BindOptions,
): Promise<void> {
  const config = loadGlobalConfig();
  const configPath = getGlobalConfigPath();

  // ── --show: read-only inspection ────────────────────────────────
  if (options.show) {
    if (!config.dotfilesRepo) {
      console.log(chalk.dim("(no binding)"));
      console.log(chalk.dim(`  Config file: ${configPath}`));
      console.log(chalk.dim(`  Run \`rotunda bind\` inside a dotfiles repo to bind.`));
      return;
    }
    console.log(config.dotfilesRepo);
    if (!existsSync(config.dotfilesRepo)) {
      console.log(
        chalk.yellow("⚠") +
          " Bound path does not exist on disk. Run `rotunda bind <new-path>` to update.",
      );
    } else if (!existsSync(join(config.dotfilesRepo, "rotunda.json"))) {
      console.log(
        chalk.yellow("⚠") +
          " Bound path is not a rotunda repo (no rotunda.json).",
      );
    }
    return;
  }

  // ── --unset: remove the binding ─────────────────────────────────
  if (options.unset) {
    if (!config.dotfilesRepo) {
      console.log(chalk.dim("No binding to remove."));
      return;
    }
    const previous = config.dotfilesRepo;
    saveGlobalConfig({ ...config, dotfilesRepo: null });
    console.log(chalk.green("✓") + ` Unbound from ${previous}`);
    console.log(chalk.dim(`  Updated: ${configPath}`));
    return;
  }

  // ── default: bind to <path> or cwd ──────────────────────────────
  const target = pathArg ? expandUserPath(pathArg) : process.cwd();

  // Validate the target is a usable rotunda repo.
  if (!existsSync(target)) {
    console.error(chalk.red("Error:") + ` Path does not exist: ${target}`);
    process.exit(1);
  }
  if (!existsSync(join(target, "rotunda.json"))) {
    console.error(
      chalk.red("Error:") +
        ` Not a rotunda repo (no rotunda.json): ${target}\n` +
        `  Run \`rotunda init\` inside the repo first to bootstrap it.`,
    );
    process.exit(1);
  }

  const previous = config.dotfilesRepo;
  saveGlobalConfig({ ...config, dotfilesRepo: target });

  if (previous && previous !== target) {
    console.log(chalk.green("✓") + ` Re-bound to ${target}`);
    console.log(chalk.dim(`  Previous: ${previous}`));
  } else if (previous === target) {
    console.log(chalk.dim(`Already bound to ${target}.`));
  } else {
    console.log(chalk.green("✓") + ` Bound to ${target}`);
  }
  console.log(chalk.dim(`  Config: ${configPath}`));
}
