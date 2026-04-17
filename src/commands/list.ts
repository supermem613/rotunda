import chalk from "chalk";
import { join } from "node:path";
import { loadRepoContext } from "../core/repo-context.js";
import { discoverFiles } from "../core/engine.js";

export async function listCommand(options: { local?: boolean; repo?: boolean }): Promise<void> {
  const { cwd, manifest } = loadRepoContext();

  const showLocal = !options.repo || options.local;  // default: show both
  const showRepo = !options.local || options.repo;

  for (const root of manifest.roots) {
    const localDir = root.local;
    const repoDir = join(cwd, root.repo);

    // Discover files on each side
    const [localFiles, repoFiles] = await Promise.all([
      showLocal
        ? discoverFiles(localDir, root.include, root.exclude, manifest.globalExclude)
        : Promise.resolve(new Map<string, string>()),
      showRepo
        ? discoverFiles(repoDir, root.include, root.exclude, manifest.globalExclude)
        : Promise.resolve(new Map<string, string>()),
    ]);

    // Merge all paths
    const allPaths = new Set([...localFiles.keys(), ...repoFiles.keys()]);
    const sorted = [...allPaths].sort();

    // Header
    console.log();
    console.log(chalk.bold.cyan(`  ┌─ ${root.repo} `));
    console.log(chalk.dim(`  │  local: ${root.local}`));
    console.log(chalk.dim(`  │  repo:  ${root.repo}`));
    console.log(chalk.dim(`  │  include: ${root.include.join(", ")}`));
    console.log(chalk.dim(`  │  exclude: ${root.exclude.slice(0, 5).join(", ")}${root.exclude.length > 5 ? ` (+${root.exclude.length - 5} more)` : ""}`));
    console.log(chalk.dim(`  │`));

    if (sorted.length === 0) {
      console.log(chalk.dim(`  │  (no files captured)`));
      console.log(chalk.cyan(`  └─ 0 files`));
      continue;
    }

    // Group by top-level directory for readability
    const groups = new Map<string, { path: string; inLocal: boolean; inRepo: boolean }[]>();
    for (const p of sorted) {
      const topDir = p.includes("/") ? p.split("/")[0] : "(root)";
      const group = groups.get(topDir) ?? [];
      group.push({
        path: p,
        inLocal: localFiles.has(p),
        inRepo: repoFiles.has(p),
      });
      groups.set(topDir, group);
    }

    for (const [dir, files] of groups) {
      console.log(chalk.dim(`  │`));
      console.log(chalk.bold(`  │  ${dir}/`));

      for (const f of files) {
        const name = f.path.includes("/") ? f.path.slice(f.path.indexOf("/") + 1) : f.path;

        let indicator: string;
        if (f.inLocal && f.inRepo) {
          indicator = chalk.green("◉"); // synced — both sides
        } else if (f.inLocal && !f.inRepo) {
          indicator = chalk.yellow("◐"); // local only
        } else {
          indicator = chalk.blue("◑"); // repo only
        }

        // Add side labels when filtering or when not on both sides
        let suffix = "";
        if (!f.inLocal && !options.repo) suffix = chalk.blue(" (repo only)");
        else if (!f.inRepo && !options.local) suffix = chalk.yellow(" (local only)");

        console.log(`  │    ${indicator} ${name}${suffix}`);
      }
    }

    // Footer with counts
    const localCount = sorted.filter((p) => localFiles.has(p)).length;
    const repoCount = sorted.filter((p) => repoFiles.has(p)).length;
    const bothCount = sorted.filter((p) => localFiles.has(p) && repoFiles.has(p)).length;
    const localOnly = localCount - bothCount;
    const repoOnly = repoCount - bothCount;

    const countParts: string[] = [];
    if (bothCount) countParts.push(chalk.green(`${bothCount} synced`));
    if (localOnly) countParts.push(chalk.yellow(`${localOnly} local-only`));
    if (repoOnly) countParts.push(chalk.blue(`${repoOnly} repo-only`));

    console.log(chalk.dim(`  │`));
    console.log(chalk.cyan(`  └─ ${sorted.length} files: ${countParts.join(", ")}`));
  }

  // Legend
  console.log();
  console.log(chalk.dim(`  Legend: ${chalk.green("◉")} synced  ${chalk.yellow("◐")} local-only  ${chalk.blue("◑")} repo-only`));
  console.log();
}
