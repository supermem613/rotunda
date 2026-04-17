/**
 * GitHub Copilot API client for LLM-assisted review.
 * Calls the GitHub Copilot Chat completions endpoint.
 */

import type { AuthToken } from "./auth.js";
import { COPILOT_EDITOR_VERSION, COPILOT_INTEGRATION_ID } from "./auth.js";
import {
  estimateTokens,
  MAX_PROMPT_TOKENS,
  TokenOverflowError,
} from "./tokens.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionResponse {
  content: string;
  finishReason: string;
}

export interface ChatCompletionOptions {
  /** Override the default max_tokens for the response. */
  maxResponseTokens?: number;
  /** Abort the request after this many milliseconds. */
  timeoutMs?: number;
}

/**
 * Call the GitHub Copilot Chat completions API.
 * Uses the Copilot Chat endpoint available to authenticated users.
 *
 * Throws `TokenOverflowError` if the estimated prompt size exceeds
 * the model limit so callers can batch / truncate before retrying.
 */
export async function chatCompletion(
  token: AuthToken,
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
): Promise<ChatCompletionResponse> {
  // ── Pre-flight token check ─────────────────────────────────
  const totalTokens = messages.reduce(
    (sum, m) => sum + estimateTokens(m.content),
    0,
  );
  if (totalTokens > MAX_PROMPT_TOKENS) {
    throw new TokenOverflowError(totalTokens, MAX_PROMPT_TOKENS);
  }

  // Use the GitHub Copilot Chat API endpoint
  const endpoint = "https://api.githubcopilot.com/chat/completions";

  const body = JSON.stringify({
    messages,
    model: "gpt-5-mini",
    temperature: 0.3,
    max_tokens: options?.maxResponseTokens ?? 4096,
  });

  const timeoutMs = options?.timeoutMs;
  const controller = timeoutMs ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const operation = (async (): Promise<ChatCompletionResponse> => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token.github_token}`,
          "Content-Type": "application/json",
          "Editor-Version": COPILOT_EDITOR_VERSION,
          "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
        },
        body,
        signal: controller?.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown error");
        throw new Error(
          `Copilot API error (${response.status}): ${errorText}`
        );
      }

      const data = await response.json() as {
        choices?: Array<{
          message?: { content?: string };
          finish_reason?: string;
        }>;
      };

      const choice = data.choices?.[0];
      if (!choice?.message?.content) {
        throw new Error("Empty response from Copilot API");
      }

      return {
        content: choice.message.content,
        finishReason: choice.finish_reason ?? "stop",
      };
    })();

    if (!timeoutMs) return operation;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new Error(`Copilot API timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    return await Promise.race([operation, timeoutPromise]);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError" && timeoutMs) {
      throw new Error(`Copilot API timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface AskResult {
  content: string;
  finishReason: string;
}

/**
 * Send a simple prompt and get a response.
 */
export async function ask(
  token: AuthToken,
  systemPrompt: string,
  userPrompt: string,
  options?: ChatCompletionOptions,
): Promise<AskResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const result = await chatCompletion(token, messages, options);
  return { content: result.content, finishReason: result.finishReason };
}

/**
 * Send a multi-turn conversation.
 */
export async function converse(
  token: AuthToken,
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
): Promise<string> {
  const result = await chatCompletion(token, messages, options);
  return result.content;
}
