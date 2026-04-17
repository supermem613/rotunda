/**
 * LLM prompt templates for review, reshape, and describe flows.
 */

import type { FileChange } from "../core/types.js";

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

export function buildExplainPrompt(
  change: FileChange,
  repoContent: string | null,
  localContent: string | null,
  diff: string,
): PromptPair {
  const system =
    "You are a code review assistant helping a developer review configuration file changes before syncing. " +
    "Be concise. Show the actual diff chunks in your explanation. Focus on what changed and why it matters.";

  let body: string;

  switch (change.action) {
    case "added": {
      const content = localContent ?? repoContent ?? "";
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
        `Previous content:\n\`\`\`\n${repoContent ?? localContent ?? ""}\n\`\`\`\n\n` +
        `Please explain what is being removed and any implications.`;
      break;
    case "modified":
    case "conflict":
    default:
      body =
        `File: ${change.relativePath}\n` +
        `Change type: ${change.action} (${change.side})\n\n` +
        `Diff:\n\`\`\`diff\n${diff}\n\`\`\`\n\n` +
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

  const parts: string[] = [];

  if (repoContent != null) {
    parts.push(`Repo version:\n\`\`\`\n${repoContent}\n\`\`\``);
  }
  if (localContent != null) {
    parts.push(`Local version:\n\`\`\`\n${localContent}\n\`\`\``);
  }
  if (diff) {
    parts.push(`Diff:\n\`\`\`diff\n${diff}\n\`\`\``);
  }
  parts.push(`Instruction: ${userInstruction}`);

  return { system, user: parts.join("\n\n") };
}

export function buildConflictPrompt(
  repoContent: string,
  localContent: string,
  repoDiff: string,
  localDiff: string,
): PromptPair {
  const system =
    "You are a merge assistant. Both the local and repo versions of this file have changed since the last sync. " +
    "Analyze whether the changes overlap. If they don't overlap, suggest a merged version. " +
    "If they do overlap, explain the conflict clearly and show both versions.";

  const user =
    `Changes in the repo since last sync:\n\`\`\`diff\n${repoDiff}\n\`\`\`\n\n` +
    `Changes locally since last sync:\n\`\`\`diff\n${localDiff}\n\`\`\`\n\n` +
    `Please analyze whether these changes overlap and suggest how to merge them.`;

  return { system, user };
}

export function buildDescribePrompt(files: DescribeFileInput[]): PromptPair {
  const system =
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

  const parts: string[] = [];
  for (const f of files) {
    let entry = `File: ${f.root}/${f.path}\nAction: ${f.action} (${f.side})`;
    if (f.diff) {
      entry += `\nDiff:\n\`\`\`diff\n${f.diff}\n\`\`\``;
    }
    if (f.content != null) {
      const truncated = f.content.length > 3000
        ? f.content.slice(0, 3000) + "\n... (truncated)"
        : f.content;
      entry += `\nContent:\n\`\`\`\n${truncated}\n\`\`\``;
    }
    parts.push(entry);
  }

  const user =
    `Analyze these ${files.length} changed file(s):\n\n` +
    parts.join("\n\n---\n\n");

  return { system, user };
}
