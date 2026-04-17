/**
 * GitHub Copilot OAuth — device code flow.
 *
 * Uses the same client_id as official Copilot integrations, then exchanges
 * the OAuth token for a short-lived Copilot API token. Tokens are persisted
 * in ~/.rotunda/auth.json and refreshed automatically when expired.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The GitHub App client_id used by the official Copilot integrations
const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";

/** Shared integration identity — used in both token exchange and API calls. */
export const COPILOT_EDITOR_VERSION = "rotunda/0.1.0";
export const COPILOT_INTEGRATION_ID = "vscode-chat";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

const ROTUNDA_DIR = join(homedir(), ".rotunda");
const AUTH_FILE = join(ROTUNDA_DIR, "auth.json");

export interface AuthToken {
  /** The short-lived Copilot API bearer token (used for API calls). */
  github_token: string;
  expires_at?: string;
}

interface StoredAuth {
  /** Long-lived GitHub OAuth token (persists across sessions). */
  oauthToken: string;
  /** Short-lived Copilot API token. */
  copilotToken?: string;
  /** Unix-ms when copilotToken expires. */
  copilotTokenExpiry?: number;
}

export function getTokenPath(): string {
  return AUTH_FILE;
}

// ─── Persistence ─────────────────────────────────────────────────────

function loadAuth(): StoredAuth | null {
  try {
    if (existsSync(AUTH_FILE)) {
      return JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    }
  } catch {
    /* corrupt file — treat as missing */
  }
  return null;
}

function saveAuth(auth: StoredAuth): void {
  mkdirSync(ROTUNDA_DIR, { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2) + "\n");
}

/** Remove the stored auth file so the next auth flow starts fresh. */
export function clearToken(): void {
  try {
    if (existsSync(AUTH_FILE)) {
      unlinkSync(AUTH_FILE);
    }
  } catch {
    /* already gone */
  }
}

// ─── Public API ──────────────────────────────────────────────────────

export async function loadToken(): Promise<AuthToken | null> {
  const auth = loadAuth();
  if (!auth?.oauthToken) return null;

  // Return cached Copilot token if still valid (with 60s buffer)
  if (
    auth.copilotToken &&
    auth.copilotTokenExpiry &&
    Date.now() < auth.copilotTokenExpiry - 60_000
  ) {
    return { github_token: auth.copilotToken };
  }

  // Exchange OAuth token for a fresh Copilot API token
  try {
    const token = await exchangeCopilotToken(auth);
    return { github_token: token };
  } catch {
    return null;
  }
}

export async function saveToken(token: AuthToken): Promise<void> {
  // Back-compat: if called externally, store as oauth token
  const auth = loadAuth() || { oauthToken: token.github_token };
  saveAuth(auth);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exchange a long-lived OAuth token for a short-lived Copilot API token.
 */
async function exchangeCopilotToken(auth: StoredAuth): Promise<string> {
  const resp = await fetch(COPILOT_TOKEN_URL, {
    headers: {
      Authorization: `token ${auth.oauthToken}`,
      Accept: "application/json",
      "Editor-Version": COPILOT_EDITOR_VERSION,
      "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(
        `Copilot token exchange failed (${resp.status}). Your OAuth token may be invalid ` +
          `or your account may not have Copilot access. Run \`rotunda auth\` to re-authenticate.\n${text}`,
      );
    }
    throw new Error(`Copilot token exchange failed: ${resp.status} ${text}`);
  }

  const data = (await resp.json()) as { token: string; expires_at: number };
  auth.copilotToken = data.token;
  auth.copilotTokenExpiry = data.expires_at * 1000; // server returns unix seconds
  saveAuth(auth);

  return data.token;
}

/**
 * Interactive device-code login. Prints a URL + code for the user to
 * authorize in their browser, then polls until approval or timeout.
 */
export async function authenticateWithDeviceFlow(): Promise<AuthToken> {
  // Step 1: Request device + user codes
  const dcResp = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: COPILOT_CLIENT_ID,
      scope: "read:user",
    }),
  });

  if (!dcResp.ok) {
    throw new Error(`Device code request failed: ${dcResp.status}`);
  }

  const dc = (await dcResp.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };

  // Step 2: Display instructions
  console.log();
  console.log("  To authenticate, visit:");
  console.log(`    ${dc.verification_uri}`);
  console.log();
  console.log(`  Enter code: ${dc.user_code}`);
  console.log();

  // Step 3: Poll for the OAuth access token
  let pollInterval = (dc.interval || 5) * 1000;
  const deadline = Date.now() + dc.expires_in * 1000;

  while (Date.now() < deadline) {
    await sleep(pollInterval);

    const tokenResp = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: COPILOT_CLIENT_ID,
        device_code: dc.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const body = (await tokenResp.json()) as Record<string, string>;

    if (body.access_token) {
      // Save the long-lived OAuth token
      const auth: StoredAuth = { oauthToken: body.access_token };
      saveAuth(auth);

      // Exchange for a short-lived Copilot API token
      const copilotToken = await exchangeCopilotToken(auth);
      return { github_token: copilotToken };
    }

    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      pollInterval += 5000;
      continue;
    }

    throw new Error(
      body.error_description || body.error || "Authentication failed",
    );
  }

  throw new Error("Device code expired. Please try again.");
}

export async function ensureAuthenticated(): Promise<AuthToken> {
  const existing = await loadToken();
  if (existing) return existing;
  return authenticateWithDeviceFlow();
}
