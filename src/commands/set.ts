import chalk from "chalk";
import {
  loadManifestDocument,
  saveManifestDocument,
  RotundaError,
  type ManifestDocument,
} from "../core/manifest.js";
import { loadRepoContext } from "../core/repo-context.js";
import { withLock } from "../utils/lock.js";
import { gitCommitAndPush, gitPull, isGitRepo } from "../utils/git.js";

export interface SetRootOptions {
  /**
   * Tri-state from commander's `--prune-empty-dirs` / `--no-prune-empty-dirs`:
   *   - undefined: flag absent, do not touch the field
   *   - true: set to true
   *   - false: clear the field (back to default-false)
   */
  pruneEmptyDirs?: boolean;
}

/**
 * Edit a single SyncRoot's structural settings in `rotunda.json` and commit.
 *
 * Lives separately from `add` and `remove` because those mutate include/exclude
 * scope and copy or delete files. `set` only edits root-level settings and never
 * touches tracked content.
 *
 * Today the only knob is `pruneEmptyDirs`; future per-root toggles should be
 * added here rather than inflating `add`'s surface.
 */
export async function setCommand(
  rootName: string,
  options: SetRootOptions = {},
): Promise<void> {
  if (!hasAnyChange(options)) {
    console.error(
      chalk.red("Error:") +
        " no settings provided. Pass at least one setting flag, e.g. --prune-empty-dirs.",
    );
    process.exit(1);
  }

  const { cwd } = loadRepoContext();

  await withLock(cwd, "set", async () => {
    if (await isGitRepo(cwd)) {
      try {
        const pulled = await gitPull(cwd);
        if (pulled) {
          console.log(chalk.dim("  ↓ Pulled latest from remote."));
        }
      } catch {
        console.log(chalk.yellow("  ⚠ git pull failed — continuing with local state."));
      }
    }

    try {
      const doc = loadManifestDocument(cwd);
      const root = doc.roots.find((r) => r.name === rootName);
      if (!root) {
        const available = doc.roots.map((r) => r.name).join(", ") || "(none)";
        throw new RotundaError(
          `No root named "${rootName}" in rotunda.json. Available roots: ${available}.`,
        );
      }

      const changes = planChanges(root, options);
      if (changes.length === 0) {
        console.log(
          chalk.dim(`  Nothing to change — "${rootName}" already matches the requested settings.`),
        );
        return;
      }

      renderPreview(rootName, changes);

      applyChanges(root, options);
      saveManifestDocument(cwd, doc);
      console.log(chalk.green("  ✓") + " Updated rotunda.json");

      if (await isGitRepo(cwd)) {
        const commitMsg = `rotunda set — ${rootName} (${changes.map((c) => c.field).join(", ")})`;
        try {
          await gitCommitAndPush(cwd, ["rotunda.json"], commitMsg, true);
          console.log(chalk.green(`  ✓ Committed and pushed: "${commitMsg}"`));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(
            chalk.yellow("  ⚠ Manifest saved but git commit/push failed. Commit manually."),
          );
          console.log(chalk.dim("    " + msg.split("\n").join("\n    ")));
        }
      }

      console.log(chalk.green("  ✓ Set complete."));
    } catch (err) {
      if (err instanceof RotundaError) {
        console.error(chalk.red("Error:") + " " + err.message);
        process.exit(1);
      }
      throw err;
    }
  });
}

interface FieldChange {
  field: string;
  from: string;
  to: string;
}

function hasAnyChange(options: SetRootOptions): boolean {
  return options.pruneEmptyDirs !== undefined;
}

function planChanges(
  root: ManifestDocument["roots"][number],
  options: SetRootOptions,
): FieldChange[] {
  const out: FieldChange[] = [];
  if (options.pruneEmptyDirs !== undefined) {
    const current = root.pruneEmptyDirs ?? false;
    if (current !== options.pruneEmptyDirs) {
      out.push({
        field: "pruneEmptyDirs",
        from: String(current),
        to: String(options.pruneEmptyDirs),
      });
    }
  }
  return out;
}

function applyChanges(
  root: ManifestDocument["roots"][number],
  options: SetRootOptions,
): void {
  if (options.pruneEmptyDirs === true) {
    root.pruneEmptyDirs = true;
  } else if (options.pruneEmptyDirs === false) {
    delete root.pruneEmptyDirs;
  }
}

function renderPreview(rootName: string, changes: FieldChange[]): void {
  console.log(chalk.bold(`\n  rotunda set ${rootName}\n`));
  console.log(chalk.bold("  rotunda.json:"));
  for (const c of changes) {
    console.log(
      `    ${chalk.cyan("set")}  ${c.field}: ${chalk.dim(c.from)} → ${chalk.green(c.to)}`,
    );
  }
  console.log();
}
