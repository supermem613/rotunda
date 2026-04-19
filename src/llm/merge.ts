/**
 * Three-way LLM merge with a typed Result return.
 *
 * Hard rule: this function NEVER throws. Any error path — auth missing,
 * HTTP failure, empty content, timeout — comes back as `{ ok: false }`
 * so the TUI's reducer can mark the row as conflict-with-error rather
 * than silently approving an empty merge.
 */

import { ask } from "./copilot.js";
import { estimateTokens, MAX_PROMPT_TOKENS, truncateToTokenBudget } from "./tokens.js";
import type { AuthToken } from "./auth.js";

export type MergeError =
  | "no-auth"
  | "empty-response"
  | "http-error"
  | "timeout"
  | "no-content"
  | "unknown";

export type MergeResult =
  | { ok: true; content: string }
  | { ok: false; error: MergeError; detail: string };

const SYSTEM_PROMPT =
  "You are a deterministic three-way merge engine. You receive the BASE version " +
  "(last common ancestor), the LOCAL version, and the REPO version of one file. " +
  "Produce a single merged version that integrates non-conflicting changes from " +
  "both sides. Where the changes truly conflict, keep BOTH and surround them with " +
  "standard git conflict markers (<<<<<<< local / ======= / >>>>>>> repo).\n" +
  "Output ONLY the merged file content. No markdown fences. No commentary. " +
  "No leading/trailing prose. Empty output is invalid.";

export interface MergeInput {
  /** Path is informational — surfaced to the model for context. */
  path: string;
  base: string | null;
  local: string;
  repo: string;
}

/**
 * Attempt a 3-way merge via Copilot. Always resolves; never rejects.
 *
 * @param token  Loaded auth token, or null if the user isn't authenticated.
 *               Returning `no-auth` lets the TUI surface a clear message
 *               rather than silently failing to call.
 */
export async function mergeViaLLM(
  token: AuthToken | null,
  input: MergeInput,
  options?: { timeoutMs?: number },
): Promise<MergeResult> {
  if (!token) {
    return { ok: false, error: "no-auth", detail: "run `rotunda auth` first" };
  }

  const userPrompt = buildMergePrompt(input);

  try {
    const result = await ask(token, SYSTEM_PROMPT, userPrompt, {
      timeoutMs: options?.timeoutMs ?? 60_000,
      maxResponseTokens: 4096,
    });
    const content = stripFences(result.content);
    if (!content || content.trim().length === 0) {
      return { ok: false, error: "empty-response", detail: "model returned no content" };
    }
    return { ok: true, content };
  } catch (err) {
    return interpretError(err);
  }
}

function interpretError(err: unknown): MergeResult {
  const msg = err instanceof Error ? err.message : String(err);
  if (/timeout/i.test(msg)) {
    return { ok: false, error: "timeout", detail: msg };
  }
  if (/Copilot API error/i.test(msg)) {
    return { ok: false, error: "http-error", detail: msg };
  }
  if (/Empty response/i.test(msg)) {
    return { ok: false, error: "empty-response", detail: msg };
  }
  return { ok: false, error: "unknown", detail: msg };
}

/**
 * Some models still wrap output in ```...``` despite the system prompt.
 * Strip a single outer fence pair if present, but only if it's the entire
 * payload — don't accidentally chew code blocks inside the file.
 */
export function stripFences(s: string): string {
  const trimmed = s.trim();
  const m = trimmed.match(/^```[a-zA-Z0-9_+\-.]*\n([\s\S]*?)\n```$/);
  if (m) return m[1];
  return trimmed;
}

function buildMergePrompt(input: MergeInput): string {
  // Budget: split remaining tokens roughly evenly across the three slices.
  const budget = MAX_PROMPT_TOKENS - estimateTokens(SYSTEM_PROMPT) - 400;
  const sliceBudget = Math.floor(budget / 3);
  const base = input.base ?? "(no common ancestor — treat both versions as new files)";
  return [
    `File: ${input.path}`,
    "",
    "BASE (last common version):",
    "```",
    truncateToTokenBudget(base, sliceBudget, "base"),
    "```",
    "",
    "LOCAL (current local content):",
    "```",
    truncateToTokenBudget(input.local, sliceBudget, "local"),
    "```",
    "",
    "REPO (current repo content):",
    "```",
    truncateToTokenBudget(input.repo, sliceBudget, "repo"),
    "```",
    "",
    "Produce the merged file now. Output ONLY the file content.",
  ].join("\n");
}
