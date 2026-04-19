# Authentication Guide

Rotunda uses GitHub Copilot as an LLM backend for reviewing file changes during push, pull, and sync operations. Authentication is required to access the Copilot API.

## Why Authentication Is Needed

When you run `rotunda push`, `rotunda pull`, or `rotunda sync`, rotunda can invoke an LLM to:

- **Explain changes** — summarize what changed in a file and why it matters.
- **Review changes** — help you decide whether to approve, reject, or modify a change before syncing.
- **Resolve conflicts** — analyze overlapping changes from both sides and suggest a merged version.
- **Reshape files** — apply user instructions to modify file content before syncing.

These features use the GitHub Copilot API, which requires a valid authentication token. You must have an active [GitHub Copilot](https://github.com/features/copilot) subscription to use LLM-assisted review.

## Step-by-Step Device Flow

Rotunda uses the [GitHub device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) for authentication, which works well in terminal environments without a browser redirect.

### 1. Start the Flow

```bash
rotunda auth
```

### 2. Copy the Code

Rotunda displays a one-time user code and a URL:

```
To authenticate, visit: https://github.com/login/device
Enter code: ABCD-1234
Waiting for authorization...
```

### 3. Authorize in Browser

1. Open [https://github.com/login/device](https://github.com/login/device) in your browser.
2. Enter the code shown in your terminal.
3. Click **Authorize** to grant rotunda access to your Copilot subscription.

### 4. Confirmation

Once authorized, rotunda saves the token and confirms:

```
✓ Authenticated successfully.
  Token saved to ~/.rotunda/auth.json
```

## Token Storage

Tokens are stored at:

```
~/.rotunda/auth.json
```

This file contains:

```json
{
  "accessToken": "ghu_...",
  "refreshToken": "ghr_...",
  "expiresAt": "2025-02-15T10:30:00.000Z"
}
```

> **Security note:** This file contains sensitive credentials. It is stored in your home directory's `.rotunda/` folder (not the repo's `.rotunda/` directory). Ensure appropriate file permissions — the file should be readable only by your user account.

## Token Refresh

- Access tokens have a limited lifetime (typically 8 hours).
- When a token expires, rotunda automatically attempts to refresh it using the stored refresh token.
- If the refresh token has also expired, rotunda prompts you to re-authenticate with `rotunda auth`.
- Token refresh is transparent — you won't notice it during normal operation.

## Troubleshooting

### Expired Token

**Symptom:** LLM review features fail with an authentication error.

**Solution:**

```bash
rotunda auth --force
```

Re-running with `--force` clears the existing token and starts a fresh device flow.

### Rate Limits

**Symptom:** LLM review returns errors after many rapid operations.

**Solution:** Wait a few minutes and try again. GitHub Copilot has rate limits that reset over time. For large syncs with many files, consider using the `-y` flag to skip LLM review.

### No Copilot Subscription

**Symptom:** Device flow completes but API calls return a 403 or subscription error.

**Solution:** Rotunda's LLM features require an active GitHub Copilot subscription. Check your subscription status at [https://github.com/settings/copilot](https://github.com/settings/copilot).

### Token File Permissions

**Symptom:** "Permission denied" when reading auth.json.

**Solution:**

```bash
# Unix/macOS
chmod 600 ~/.rotunda/auth.json

# Windows (PowerShell)
icacls "$env:USERPROFILE\.rotunda\auth.json" /inheritance:r /grant:r "$($env:USERNAME):F"
```

### Network Issues

**Symptom:** Device flow hangs at "Waiting for authorization..."

**Solution:** Ensure you have internet access and can reach `github.com`. If you are behind a corporate proxy, configure your proxy settings in your shell environment.

## Using Rotunda Without Authentication

All core sync operations work without authentication. LLM-assisted review is an optional enhancement:

| Feature                  | Requires Auth? |
|--------------------------|----------------|
| `rotunda init`           | No             |
| `rotunda status`         | No             |
| `rotunda diff`           | No             |
| `rotunda push` (with `-y`) | No          |
| `rotunda pull` (with `-y`) | No          |
| `rotunda push` (interactive review) | Yes |
| `rotunda pull` (interactive review) | Yes |
| `rotunda sync` (conflict resolution) | Yes |
| `rotunda doctor`         | No             |

When authentication is not configured, rotunda falls back to basic review mode:

- **Push/pull** show the changes and ask for a simple yes/no confirmation without LLM explanation.
- **Sync** skips LLM-assisted conflict resolution and reports conflicts for manual resolution.
- **All file operations** (copy, delete, hash, state tracking) work identically.

You can always add authentication later with `rotunda auth` when you want LLM-assisted review.

## Related

- [Command Reference](commands.md) — `rotunda auth` and other commands
- [Architecture Guide](architecture.md) — how LLM integration works
