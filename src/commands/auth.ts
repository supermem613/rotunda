import chalk from "chalk";
import { authenticateWithDeviceFlow, loadToken, clearToken } from "../llm/auth.js";

export async function authCommand(options: { force?: boolean }): Promise<void> {
  if (!options.force) {
    const existing = await loadToken();
    if (existing) {
      console.log(chalk.green("✔ Already authenticated with GitHub."));
      console.log(chalk.dim("  Use --force to re-authenticate."));
      return;
    }
  }

  if (options.force) {
    clearToken();
    console.log(chalk.dim("  Cleared existing token."));
  }

  console.log(chalk.cyan("Authenticating with GitHub Copilot…"));

  try {
    await authenticateWithDeviceFlow();
    console.log(chalk.green("✔ Authentication successful! Token saved."));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`✖ Authentication failed: ${msg}`));
    process.exit(1);
  }
}
