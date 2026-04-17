# FAQ

**Q: Does Rotunda replace chezmoi?**
No. Use chezmoi for general dotfiles (`.bashrc`, `.gitconfig`, `.zshrc`). Use Rotunda for AI agent configs that change at runtime. See [Converting from chezmoi](converting-from-chezmoi.md).

**Q: What happens if I don't authenticate with Copilot?**
Everything still works — push, pull, status, diff, doctor, list. You just won't get LLM explanations during push/pull, and `doctor --fix` requires auth. Use `-y` to skip the review step.

**Q: Can I add custom sync roots beyond Claude and Copilot?**
Yes. Edit `rotunda.json` and add any directory pair. Rotunda doesn't care what the files are — it just syncs based on include/exclude patterns. See [Manifest Reference](manifest.md).

**Q: How are conflicts resolved?**
Rotunda detects conflicts (both sides changed the same file) and surfaces them. With LLM review enabled, Copilot analyzes whether the changes overlap and suggests a merged version. You always have the final say.

**Q: Is the state file committed to git?**
No. `.rotunda/` is gitignored. State is per-machine — each machine tracks its own last-sync hashes independently.

**Q: What files does `rotunda init` create by default?**
The default manifest includes two roots: `~/.claude` (skills, agents, hooks, CLAUDE.md, settings, MCP config) and `~/.copilot` (agents, extensions, hooks, config). Sensitive directories like sessions, cache, credentials, and telemetry are excluded by default.

**Q: Does Rotunda modify my git history?**
`rotunda push` creates a commit in the dotfiles repo with the synced files. It uses a simple commit message like `rotunda push — 5 file(s)`. It does not force-push, rebase, or modify existing history.

**Q: Can I use Rotunda without git?**
The sync engine itself doesn't require git — it works with plain directories and SHA-256 hashes. However, the push command auto-commits changes, and the diff command uses `git diff --no-index` for terminal output. A git repo is strongly recommended.

**Q: What about machine-specific configs like `mcp.json`?**
Use `machineOverrides` in `rotunda.json` to exclude specific files on specific machines. Hostnames are matched case-insensitively. See [Machine Overrides](manifest.md#machine-overrides).
