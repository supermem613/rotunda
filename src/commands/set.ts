import chalk from "chalk";
import {
  loadManifestDocument,
  saveManifestDocument,
  RotundaError,
  type ManifestDocument,
} from "../core/manifest.js";
import { loadRepoContext } from "../core/repo-context.js";
import { withLock } from "../utils/lock.js";
import { isGitRepo } from "../utils/git.js";
import { pruneSettingsEqual } from "../core/include-glob.js";
import { resolveBackend } from "../utils/vcs.js";

export interface SetRootOptions {
  /**
   * Tri-state from commander, accumulated by the prune collector parser:
   *   - undefined: flag absent, do not touch the field
   *   - true: `--prune-empty-dirs` alone → boundary is the whole root
   *   - false: `--no-prune-empty-dirs` → clear the field
   *   - string[]: one or more `--prune-empty-dirs <sub-path>` invocations
   */
  pruneEmptyDirs?: boolean | string[];
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
  let backend = resolveBackend(cwd);

  await withLock(cwd, "set", async () => {
    if (await isGitRepo(cwd)) {
      try {
        const pulled = await backend.pull(cwd);
        if (pulled) {
          console.log(chalk.dim("  ↓ Pulled latest from remote."));
          // A pull can change the manifest's vcs field, so re-resolve the
          // backend to publish through the backend the repo now declares.
          backend = resolveBackend(cwd);
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
          await backend.publish(cwd, ["rotunda.json"], commitMsg);
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

function normalizeRequest(
  requested: boolean | string[],
): boolean | string[] {
  if (typeof requested === "boolean") {
    return requested;
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of requested) {
    const norm = raw.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").trim();
    if (!norm || seen.has(norm)) {
      continue;
    }
    seen.add(norm);
    out.push(norm);
  }
  return out.length === 0 ? false : out;
}

function formatPrune(v: boolean | string[] | undefined): string {
  if (v === undefined || v === false) {
    return "false";
  }
  if (v === true) {
    return "true";
  }
  return `[${v.join(", ")}]`;
}

function planChanges(
  root: ManifestDocument["roots"][number],
  options: SetRootOptions,
): FieldChange[] {
  const out: FieldChange[] = [];
  if (options.pruneEmptyDirs !== undefined) {
    const requested = normalizeRequest(options.pruneEmptyDirs);
    if (!pruneSettingsEqual(root.pruneEmptyDirs, requested === false ? undefined : requested)) {
      out.push({
        field: "pruneEmptyDirs",
        from: formatPrune(root.pruneEmptyDirs),
        to: formatPrune(requested === false ? undefined : requested),
      });
    }
  }
  return out;
}

function applyChanges(
  root: ManifestDocument["roots"][number],
  options: SetRootOptions,
): void {
  if (options.pruneEmptyDirs !== undefined) {
    const normalized = normalizeRequest(options.pruneEmptyDirs);
    if (normalized === false) {
      delete root.pruneEmptyDirs;
    } else {
      root.pruneEmptyDirs = normalized;
    }
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

