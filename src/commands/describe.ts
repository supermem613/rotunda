/**
 * `rotunda describe` — LLM-generated hierarchical analysis of changes
 * (overview → files → chunks → observations).
 *
 * For raw diffs, use `rotunda diff`.
 */

import chalk from "chalk";
import { loadRepoContext } from "../core/repo-context.js";
import { loadState } from "../core/state.js";
import { computeAllChanges } from "../core/engine.js";
import { gitDiffFiles } from "../utils/git.js";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { loadToken } from "../llm/auth.js";
import { ask } from "../llm/copilot.js";
import type { AskResult } from "../llm/copilot.js";
import {
  buildDescribePrompt,
  estimateDescribeFileTokens,
  getDescribeSystemTokens,
} from "../llm/prompts.js";
import type { DescribeFileInput } from "../llm/prompts.js";
import { MAX_PROMPT_TOKENS } from "../llm/tokens.js";
import { createProgress } from "../utils/progress.js";
import type { Progress } from "../utils/progress.js";

// ─── Types ───────────────────────────────────────────────────

export interface DescribeAnalysis {
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
export function parseAnalysis(raw: string): DescribeAnalysis {
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
export function wrapText(text: string, width: number): string[] {
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
  const { cwd, manifest } = loadRepoContext();

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

  // ── Gather file data for LLM ──────────────────────────────

  const fileInfos: DescribeFileInput[] = [];

  for (const c of changes) {
    const rootDef = manifest.roots.find((r) => r.repo === c.rootName);
    if (!rootDef) continue;

    const localFile = join(rootDef.local, c.relativePath);
    const repoFile  = join(cwd, rootDef.repo, c.relativePath);

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

  // ── LLM analysis ──────────────────────────────────────────

  if (fileInfos.length === 0) {
    console.log(chalk.green("✓") + " No changes to describe.");
    return;
  }

  console.log(chalk.bold(`\n${"─".repeat(60)}`));
  console.log(
    chalk.bold("  🤖 Analysis") +
    chalk.dim("  powered by GitHub Copilot")
  );
  console.log(chalk.bold(`${"─".repeat(60)}\n`));

  try {
    const analysis = await analyzeWithBatching(token, fileInfos);
    renderAnalysis(analysis);
  } catch (err) {
    console.error(chalk.yellow("  ⚠ Could not get LLM analysis."));
    console.error(chalk.dim(`  Error: ${err}`));
  }

  console.log();
}

// ─── Constants ───────────────────────────────────────────────

/** Per-file response token budget — enough for summary + chunks + observations. */
const RESPONSE_TOKENS_PER_FILE = 150;
/** Minimum response token budget for any API call. */
const MIN_RESPONSE_TOKENS = 4096;
/** Maximum response token budget (model ceiling). */
const MAX_RESPONSE_TOKENS = 16384;
/** Timeout for a single Copilot API call. */
const API_TIMEOUT_MS = 90_000;

// ─── Adaptive batching ──────────────────────────────────────

/**
 * Estimate the *raw* (untruncated) token cost of sending all files
 * in one describe call.  Used to decide whether batching is needed
 * BEFORE `buildDescribePrompt` truncates everything to fit.
 */
function estimateRawDescribeTokens(files: DescribeFileInput[]): number {
  const overhead = getDescribeSystemTokens();
  return files.reduce(
    (sum, f) => sum + estimateDescribeFileTokens(f),
    overhead,
  );
}

/** Compute a response-token budget scaled to the number of files. */
export function responseTokenBudget(fileCount: number): number {
  return Math.min(
    MAX_RESPONSE_TOKENS,
    Math.max(MIN_RESPONSE_TOKENS, fileCount * RESPONSE_TOKENS_PER_FILE),
  );
}

/**
 * Send a single describe batch to the API with timeout and
 * truncation detection.  Returns null if the response was
 * truncated (finish_reason === "length") so callers can retry
 * with smaller batches.
 */
async function sendDescribeBatch(
  token: Awaited<ReturnType<typeof loadToken>> & {},
  batch: DescribeFileInput[],
  progress?: Progress,
): Promise<DescribeAnalysis | null> {
  const { system, user } = buildDescribePrompt(batch);
  const result: AskResult = await ask(token, system, user, {
    maxResponseTokens: responseTokenBudget(batch.length),
    timeoutMs: API_TIMEOUT_MS,
  });

  if (result.finishReason === "length") return null;
  progress?.tick(batch.length);
  return parseAnalysis(result.content);
}

/**
 * Analyze files with adaptive batching:
 *   1. If the raw content fits in one call → send everything.
 *   2. If not → split into batches so each batch gets more per-file budget.
 *   3. On timeout or truncation → split the failing batch smaller.
 *   4. If a single file still fails → skip it gracefully.
 */
async function analyzeWithBatching(
  token: Awaited<ReturnType<typeof loadToken>> & {},
  fileInfos: DescribeFileInput[],
): Promise<DescribeAnalysis> {
  const rawTokens = estimateRawDescribeTokens(fileInfos);
  const progress = createProgress(fileInfos.length);

  // ── Fast path: everything fits without truncation ──────────
  if (rawTokens <= MAX_PROMPT_TOKENS) {
    const result = await sendDescribeBatch(token, fileInfos, progress);
    if (result) {
      progress.done();
      return result;
    }
    // Truncated — fall through to batching
  }

  // ── Slow path: batch by raw size ───────────────────────────
  const batches = splitIntoBatches(fileInfos);
  const merged: DescribeAnalysis = { overview: "", files: [] };
  const overviews: string[] = [];

  for (const batch of batches) {
    try {
      const result = await sendDescribeBatch(token, batch, progress);

      if (result) {
        overviews.push(result.overview);
        merged.files.push(...result.files);
        continue;
      }

      // Truncated response — split this batch smaller
      if (batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        for (const half of [batch.slice(0, mid), batch.slice(mid)]) {
          const sub = await sendDescribeBatch(token, half, progress);
          if (sub) {
            overviews.push(sub.overview);
            merged.files.push(...sub.files);
          } else {
            await analyzeFilesIndividually(token, half, overviews, merged, progress);
          }
        }
      } else {
        // Single file truncated — accept best-effort parse
        const { system, user } = buildDescribePrompt(batch);
        const raw = await ask(token, system, user, {
          maxResponseTokens: MAX_RESPONSE_TOKENS,
          timeoutMs: API_TIMEOUT_MS,
        });
        const parsed = parseAnalysis(raw.content);
        overviews.push(parsed.overview);
        merged.files.push(...parsed.files);
        progress.tick(1);
      }
    } catch (err) {
      // Timeout or API error — try splitting the batch
      if (batch.length > 1) {
        await analyzeFilesIndividually(token, batch, overviews, merged, progress);
      } else {
        merged.files.push({
          path: batch[0].path,
          root: batch[0].root,
          action: batch[0].action,
          summary: "(analysis skipped — request failed)",
          chunks: [],
        });
        progress.tick(1);
      }
    }
  }

  progress.done();

  merged.overview = overviews.length === 1
    ? overviews[0]
    : overviews.join(" ");

  return merged;
}

/** Fallback: analyze each file individually, skipping failures. */
async function analyzeFilesIndividually(
  token: Awaited<ReturnType<typeof loadToken>> & {},
  files: DescribeFileInput[],
  overviews: string[],
  merged: DescribeAnalysis,
  progress: Progress,
): Promise<void> {
  for (const file of files) {
    try {
      const result = await sendDescribeBatch(token, [file], progress);
      if (result) {
        overviews.push(result.overview);
        merged.files.push(...result.files);
      } else {
        // Truncated single file — best-effort
        const { system, user } = buildDescribePrompt([file]);
        const raw = await ask(token, system, user, {
          maxResponseTokens: MAX_RESPONSE_TOKENS,
          timeoutMs: API_TIMEOUT_MS,
        });
        const parsed = parseAnalysis(raw.content);
        overviews.push(parsed.overview);
        merged.files.push(...parsed.files);
        progress.tick(1);
      }
    } catch {
      merged.files.push({
        path: file.path,
        root: file.root,
        action: file.action,
        summary: "(analysis skipped — content too large)",
        chunks: [],
      });
      progress.tick(1);
    }
  }
}

/**
 * Split files into batches using *raw* (untruncated) token estimates.
 * Greedy packing: keeps adding files until the next one would push
 * the batch over the token budget, then starts a new batch.
 */
export function splitIntoBatches(files: DescribeFileInput[]): DescribeFileInput[][] {
  const systemOverhead = getDescribeSystemTokens();
  const budget = MAX_PROMPT_TOKENS;

  const batches: DescribeFileInput[][] = [];
  let current: DescribeFileInput[] = [];
  let currentTokens = systemOverhead;

  for (const file of files) {
    const fileTokens = estimateDescribeFileTokens(file);

    if (currentTokens + fileTokens > budget && current.length > 0) {
      batches.push(current);
      current = [file];
      currentTokens = systemOverhead + fileTokens;
    } else {
      current.push(file);
      currentTokens += fileTokens;
    }
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}
