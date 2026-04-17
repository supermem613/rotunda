/**
 * GitHub Copilot API client for LLM-assisted review.
 * Calls the GitHub Copilot Chat completions endpoint.
 */

import type { AuthToken } from "./auth.js";
import { COPILOT_EDITOR_VERSION, COPILOT_INTEGRATION_ID } from "./auth.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionResponse {
  content: string;
  finishReason: string;
}

/**
 * Call the GitHub Copilot Chat completions API.
 * Uses the Copilot Chat endpoint available to authenticated users.
 */
export async function chatCompletion(
  token: AuthToken,
  messages: ChatMessage[],
): Promise<ChatCompletionResponse> {
  // Use the GitHub Copilot Chat API endpoint
  const endpoint = "https://api.githubcopilot.com/chat/completions";

  const body = JSON.stringify({
    messages,
    model: "gpt-4o",
    temperature: 0.3,
    max_tokens: 2048,
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token.github_token}`,
      "Content-Type": "application/json",
      "Editor-Version": COPILOT_EDITOR_VERSION,
      "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
    },
    body,
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
}

/**
 * Send a simple prompt and get a response.
 */
export async function ask(
  token: AuthToken,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const result = await chatCompletion(token, messages);
  return result.content;
}

/**
 * Send a multi-turn conversation.
 */
export async function converse(
  token: AuthToken,
  messages: ChatMessage[],
): Promise<string> {
  const result = await chatCompletion(token, messages);
  return result.content;
}
