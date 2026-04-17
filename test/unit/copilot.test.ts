import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { chatCompletion } from "../../src/llm/copilot.js";
import type { AuthToken } from "../../src/llm/auth.js";

const TOKEN: AuthToken = { github_token: "test-token" };

describe("chatCompletion timeout behavior", () => {
  beforeEach(() => {
    mock.restoreAll();
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it("returns parsed content for a normal response", async () => {
    mock.method(globalThis, "fetch", async () =>
      ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
      }) as Response,
    );

    const result = await chatCompletion(
      TOKEN,
      [{ role: "user", content: "hello" }],
      { timeoutMs: 1000 },
    );

    assert.equal(result.content, "ok");
    assert.equal(result.finishReason, "stop");
  });

  it("times out when the response body never resolves", async () => {
    mock.method(globalThis, "fetch", async () =>
      ({
        ok: true,
        json: async () => await new Promise(() => {}),
      }) as Response,
    );

    await assert.rejects(
      () =>
        chatCompletion(
          TOKEN,
          [{ role: "user", content: "hello" }],
          { timeoutMs: 25 },
        ),
      /timeout/i,
    );
  });
});
