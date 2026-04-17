/**
 * `rotunda describe` — show raw diffs then an LLM-generated
 * hierarchical analysis (overview → files → chunks → observations).
 */

import chalk from "chalk";
import { loadManifest } from "../core/manifest.js";
import { loadState } from "../core/state.js";
import { computeAllChanges } from "../core/engine.js";
import { gitDiffFiles } from "../utils/git.js";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { loadToken } from "../llm/auth.js";
import { ask } from "../llm/copilot.js";
import { buildDescribePrompt } from "../llm/prompts.js";
import type { DescribeFileInput } from "../llm/prompts.js";
import type { FileChange } from "../core/types.js";

// ─── Types ───────────────────────────────────────────────────

interface DescribeAnalysis {
  overview: string;
  files: Array<{
    path: string;
    root: string;
    action: string;
    summary: string;
    chunks: Array<{ header: string; description: string }>;
    observations?: string[];
  }>;
}

// ─── Helpers ─────────────────────────────────────────────────

async function readFileContent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/** Robustly extract JSON from an LLM response that may include fences. */
function parseAnalysis(raw: string): DescribeAnalysis {
  try { return JSON.parse(raw); } catch { /* continue */ }

  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]); } catch { /* continue */ }
  }

  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch { /* continue */ }
  }

  // Fallback: treat entire response as the overview
  return { overview: raw, files: [] };
}

/** Word-wrap text to a given width. */
function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length + word.length + 1 > width && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

// ─── Rendering ───────────────────────────────────────────────

function renderAnalysis(analysis: DescribeAnalysis): void {
  console.log(chalk.bold.cyan("  📋 Overview\n"));
  for (const line of wrapText(analysis.overview, 72)) {
    console.log(`  ${line}`);
  }
  console.log();

  for (const file of analysis.files) {
    const actionColor =
      file.action === "added"    ? chalk.green :
      file.action === "deleted"  ? chalk.red :
      file.action === "conflict" ? chalk.magenta :
      chalk.yellow;

    console.log(
      chalk.bold(`  📁 ${file.root} / ${file.path}`) +
      "  " + actionColor(file.action)
    );

    console.log(chalk.dim("  │"));
    for (const line of wrapText(file.summary, 68)) {
      console.log(chalk.dim("  │  ") + line);
    }

    const chunks = file.chunks ?? [];
    const hasObs = (file.observations?.length ?? 0) > 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk  = chunks[i];
      const isLast = i === chunks.length - 1 && !hasObs;
      const branch = isLast ? "└─" : "├─";
      const pipe   = isLast ? "   " : "│  ";

      console.log(chalk.dim("  │"));
      console.log(chalk.dim(`  ${branch} `) + chalk.cyan(chunk.header));
      for (const line of wrapText(chunk.description, 65)) {
        console.log(chalk.dim(`  ${pipe}`) + line);
      }
    }

    if (hasObs) {
      console.log(chalk.dim("  │"));
      const obs = file.observations!;
      for (let i = 0; i < obs.length; i++) {
        const isLast = i === obs.length - 1;
        const branch = isLast ? "└─" : "├─";
        console.log(
          chalk.dim(`  ${branch} `) + chalk.yellow("💡 " + obs[i])
        );
      }
    }

    console.log();
  }
}

// ─── Command ─────────────────────────────────────────────────

export async function describeCommand(
  root: string | undefined
): Promise<void> {
  const cwd = process.cwd();

  let manifest;
  try {
    manifest = loadManifest(cwd);
  } catch {
    console.error(
      chalk.red("Error:") +
      " Could not load rotunda.json. Run `rotunda init` first."
    );
    process.exit(1);
  }

  const token = await loadToken();
  if (!token) {
    console.error(
      chalk.red("Error:") +
      " Not authenticated. Run `rotunda auth` to enable LLM analysis."
    );
    console.error(
      chalk.dim("  The describe command uses GitHub Copilot to explain changes.")
    );
    process.exit(1);
  }

  const state = await loadState(cwd);
  let changes = await computeAllChanges(manifest, cwd, state);

  if (root) {
    changes = changes.filter(
      (c) =>
        c.rootName === root ||
        manifest.roots.some((r) => r.name === root && r.repo === c.rootName)
    );
    if (changes.length === 0) {
      console.log(chalk.green("✓") + ` No changes in root '${root}'.`);
      return;
    }
  }

  if (changes.length === 0) {
    console.log(chalk.green("✓") + " No changes to describe.");
    return;
  }

  // ── Phase 1: Raw diff ─────────────────────────────────────

  const fileInfos: DescribeFileInput[] = [];
  const byRoot = new Map<string, FileChange[]>();
  for (const c of changes) {
    const group = byRoot.get(c.rootName) ?? [];
    group.push(c);
    byRoot.set(c.rootName, group);
  }

  console.log(chalk.bold(`\n${"─".repeat(60)}`));
  console.log(chalk.bold("  Diff"));
  console.log(chalk.bold(`${"─".repeat(60)}`));

  for (const [rootName, rootChanges] of byRoot) {
    console.log(
      chalk.bold(
        `\n── ${rootName} ${"─".repeat(Math.max(0, 55 - rootName.length))}`
      )
    );

    const rootDef = manifest.roots.find((r) => r.repo === rootName);
    if (!rootDef) continue;

    for (const c of rootChanges) {
      const localFile = join(rootDef.local, c.relativePath);
      const repoFile  = join(cwd, rootDef.repo, c.relativePath);

      if (c.action === "modified" || c.action === "conflict") {
        try {
          const colorDiff = await gitDiffFiles(repoFile, localFile, true);
          if (colorDiff) console.log(colorDiff);
        } catch {
          console.log(chalk.dim(`  (could not diff ${c.relativePath})`));
        }
      } else if (c.action === "added") {
        const label = c.side === "local" ? "added locally" : "added in repo";
        console.log(chalk.green(`  + ${c.relativePath} (${label})`));
      } else if (c.action === "deleted") {
        const label = c.side === "local" ? "deleted locally" : "deleted in repo";
        console.log(chalk.red(`  - ${c.relativePath} (${label})`));
      }

      let plainDiff = "";
      if (c.action === "modified" || c.action === "conflict") {
        try {
          plainDiff = await gitDiffFiles(repoFile, localFile, false);
        } catch { /* diff unavailable */ }
      }

      let content: string | null = null;
      if (c.action === "added") {
        content = await readFileContent(
          c.side === "local" ? localFile : repoFile
        );
      } else if (c.action === "deleted") {
        content = await readFileContent(
          c.side === "local" ? repoFile : localFile
        );
      }

      fileInfos.push({
        path: c.relativePath,
        root: c.rootName,
        action: c.action,
        side: c.side,
        diff: plainDiff,
        content,
      });
    }
  }

  // ── Phase 2: LLM analysis ─────────────────────────────────

  console.log(chalk.bold(`\n${"─".repeat(60)}`));
  console.log(
    chalk.bold("  🤖 Analysis") +
    chalk.dim("  powered by GitHub Copilot")
  );
  console.log(chalk.bold(`${"─".repeat(60)}\n`));

  try {
    const { system, user } = buildDescribePrompt(fileInfos);
    const response = await ask(token, system, user);
    const analysis = parseAnalysis(response);
    renderAnalysis(analysis);
  } catch (err) {
    console.error(chalk.yellow("  ⚠ Could not get LLM analysis."));
    console.error(chalk.dim(`  ${err}`));
  }

  console.log();
}
