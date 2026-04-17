import chalk from "chalk";
import { authenticateWithDeviceFlow, loadToken } from "../llm/auth.js";

export async function authCommand(): Promise<void> {
  const existing = await loadToken();
  if (existing) {
    console.log(chalk.green("✔ Already authenticated with GitHub."));
    return;
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
