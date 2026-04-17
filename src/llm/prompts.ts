/**
 * LLM prompt templates for review, reshape, and describe flows.
 */

import type { FileChange } from "../core/types.js";
import {
  estimateTokens,
  truncateToTokenBudget,
  truncateDiff,
  MAX_PROMPT_TOKENS,
} from "./tokens.js";

interface PromptPair {
  system: string;
  user: string;
}

// ─── Describe types ──────────────────────────────────────────

/** Input to `buildDescribePrompt` — one entry per changed file. */
export interface DescribeFileInput {
  path: string;
  root: string;
  action: string;
  side: string;
  /** Plain (uncolored) unified diff for modified/conflict files. */
  diff: string;
  /** Full file content for added/deleted files (may be null). */
  content: string | null;
}

// ─── Per-file budget helper ──────────────────────────────────

/** Cap diff and content for a single file to stay within a token budget. */
function capFilePayload(
  diff: string,
  content: string | null,
  budgetTokens: number,
): { diff: string; content: string | null } {
  // Reserve a small fixed amount for metadata lines (path, action, etc.)
  const metaOverhead = 50; // ~50 tokens for framing
  let remaining = budgetTokens - metaOverhead;
  if (remaining < 200) remaining = 200; // absolute floor

  let cappedDiff = diff;
  let cappedContent = content;

  if (diff) {
    // Diff gets 70% of the budget, content gets 30%
    const diffBudget = content != null
      ? Math.floor(remaining * 0.7)
      : remaining;
    cappedDiff = truncateDiff(diff, diffBudget);
    remaining -= estimateTokens(cappedDiff);
  }

  if (content != null) {
    const contentBudget = Math.max(remaining, 200);
    cappedContent = truncateToTokenBudget(content, contentBudget, "file content");
  }

  return { diff: cappedDiff, content: cappedContent };
}

/**
 * Estimate the raw (untruncated) token cost of a single describe file entry.
 * Used by the batching layer to decide whether files fit in one call.
 */
export function estimateDescribeFileTokens(f: DescribeFileInput): number {
  let tokens = 50; // metadata overhead (path, action, fences, separators)
  if (f.diff) tokens += estimateTokens(f.diff);
  if (f.content != null) tokens += estimateTokens(f.content);
  return tokens;
}

/**
 * Return the token cost of the describe system prompt (constant per call).
 */
export function getDescribeSystemTokens(): number {
  return estimateTokens(DESCRIBE_SYSTEM_PROMPT) + 100; // +100 for framing
}

export function buildExplainPrompt(
  change: FileChange,
  repoContent: string | null,
  localContent: string | null,
  diff: string,
): PromptPair {
  const system =
    "You are a code review assistant helping a developer review configuration file changes before syncing. " +
    "Be concise. Show the actual diff chunks in your explanation. Focus on what changed and why it matters.";

  // Budget: total limit minus system prompt
  const budget = MAX_PROMPT_TOKENS - estimateTokens(system) - 200;
  const { diff: cappedDiff, content: cappedContent } = capFilePayload(
    diff,
    localContent ?? repoContent,
    budget,
  );

  let body: string;

  switch (change.action) {
    case "added": {
      const content = cappedContent ?? "";
      body =
        `File: ${change.relativePath}\n` +
        `Change type: added (${change.side})\n\n` +
        `Full content of the new file:\n\`\`\`\n${content}\n\`\`\`\n\n` +
        `Please explain what this new file contains and its purpose.`;
      break;
    }
    case "deleted":
      body =
        `File: ${change.relativePath}\n` +
        `Change type: deleted (${change.side})\n\n` +
        `This file is being removed.\n\n` +
        `Previous content:\n\`\`\`\n${cappedContent ?? ""}\n\`\`\`\n\n` +
        `Please explain what is being removed and any implications.`;
      break;
    case "modified":
    case "conflict":
    default:
      body =
        `File: ${change.relativePath}\n` +
        `Change type: ${change.action} (${change.side})\n\n` +
        `Diff:\n\`\`\`diff\n${cappedDiff}\n\`\`\`\n\n` +
        `Please provide a clear explanation of these changes.`;
      break;
  }

  return { system, user: body };
}

export function buildReshapePrompt(
  repoContent: string | null,
  localContent: string | null,
  diff: string,
  userInstruction: string,
): PromptPair {
  const system =
    "You are a code editor. The user wants to modify a file before syncing. " +
    "Apply their instruction to the local version of the file. " +
    "Output ONLY the complete new file content, nothing else. No markdown fences, no explanation.";

  // Budget: total limit minus system prompt minus instruction overhead
  const budget = MAX_PROMPT_TOKENS - estimateTokens(system) - estimateTokens(userInstruction) - 300;
  // Split budget: repo content, local content, and diff each get a third
  const sliceBudget = Math.floor(budget / 3);

  const parts: string[] = [];

  if (repoContent != null) {
    const capped = truncateToTokenBudget(repoContent, sliceBudget, "repo content");
    parts.push(`Repo version:\n\`\`\`\n${capped}\n\`\`\``);
  }
  if (localContent != null) {
    const capped = truncateToTokenBudget(localContent, sliceBudget, "local content");
    parts.push(`Local version:\n\`\`\`\n${capped}\n\`\`\``);
  }
  if (diff) {
    const capped = truncateDiff(diff, sliceBudget);
    parts.push(`Diff:\n\`\`\`diff\n${capped}\n\`\`\``);
  }
  parts.push(`Instruction: ${userInstruction}`);

  return { system, user: parts.join("\n\n") };
}

export function buildConflictPrompt(
  _repoContent: string,
  _localContent: string,
  repoDiff: string,
  localDiff: string,
): PromptPair {
  const system =
    "You are a merge assistant. Both the local and repo versions of this file have changed since the last sync. " +
    "Analyze whether the changes overlap. If they don't overlap, suggest a merged version. " +
    "If they do overlap, explain the conflict clearly and show both versions.";

  // Each diff gets half the remaining budget
  const budget = MAX_PROMPT_TOKENS - estimateTokens(system) - 300;
  const perDiffBudget = Math.floor(budget / 2);

  const cappedRepoDiff = truncateDiff(repoDiff, perDiffBudget);
  const cappedLocalDiff = truncateDiff(localDiff, perDiffBudget);

  const user =
    `Changes in the repo since last sync:\n\`\`\`diff\n${cappedRepoDiff}\n\`\`\`\n\n` +
    `Changes locally since last sync:\n\`\`\`diff\n${cappedLocalDiff}\n\`\`\`\n\n` +
    `Please analyze whether these changes overlap and suggest how to merge them.`;

  return { system, user };
}

// ─── Describe system prompt (shared constant) ───────────────

const DESCRIBE_SYSTEM_PROMPT =
  "You are a senior developer analyzing configuration file changes for a sync tool. " +
  "The user wants to understand what changed across all files.\n\n" +
  "Respond with a JSON object (no markdown fences, no explanation outside the JSON) matching this schema:\n" +
  "{\n" +
  '  "overview": "2-3 sentences summarizing the overall theme and impact of all changes",\n' +
  '  "files": [\n' +
  "    {\n" +
  '      "path": "relative/path",\n' +
  '      "root": "root-name",\n' +
  '      "action": "added|modified|deleted|conflict",\n' +
  '      "summary": "1-2 sentence summary of what changed in this file",\n' +
  '      "chunks": [\n' +
  '        { "header": "@@ line range or short label", "description": "What this chunk does and why it matters" }\n' +
  "      ],\n" +
  '      "observations": ["optional noteworthy things: patterns, risks, suggestions"]\n' +
  "    }\n" +
  "  ]\n" +
  "}\n\n" +
  "Rules:\n" +
  "- For added/deleted files with no diff hunks, use a single chunk with header 'entire file'.\n" +
  "- Keep descriptions factual and concise.\n" +
  "- observations is optional — only include when genuinely useful.\n" +
  "- Output ONLY the JSON object. No surrounding text.";

export function buildDescribePrompt(
  files: DescribeFileInput[],
  tokenBudget = MAX_PROMPT_TOKENS,
): PromptPair {
  const system = DESCRIBE_SYSTEM_PROMPT;

  // ── Per-file budget ────────────────────────────────────────
  const systemTokens = estimateTokens(system);
  const framingOverhead = 100; // "Analyze these N changed file(s):" + separators
  const availableTokens = tokenBudget - systemTokens - framingOverhead;
  const perFileBudget = Math.max(
    200,
    Math.floor(availableTokens / Math.max(files.length, 1)),
  );

  const parts: string[] = [];
  for (const f of files) {
    const { diff: cappedDiff, content: cappedContent } = capFilePayload(
      f.diff,
      f.content,
      perFileBudget,
    );

    let entry = `File: ${f.root}/${f.path}\nAction: ${f.action} (${f.side})`;
    if (cappedDiff) {
      entry += `\nDiff:\n\`\`\`diff\n${cappedDiff}\n\`\`\``;
    }
    if (cappedContent != null) {
      entry += `\nContent:\n\`\`\`\n${cappedContent}\n\`\`\``;
    }
    parts.push(entry);
  }

  const user =
    `Analyze these ${files.length} changed file(s):\n\n` +
    parts.join("\n\n---\n\n");

  return { system, user };
}
