# Contributing to Rotunda

Thank you for your interest in contributing to rotunda! This guide covers everything you need to get started.

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) 20 or later
- [Git](https://git-scm.com/)

### Getting Started

```bash
# Clone the repository
git clone https://github.com/<your-username>/rotunda.git
cd rotunda

# Install dependencies
npm install

# Build the project
npm run build

# Link for local development (makes `rotunda` available globally)
npm link
```

After linking, the `rotunda` command in your terminal runs your local build.

### Rebuilding After Changes

```bash
npm run build        # Compile TypeScript → dist/
npm run lint         # Type-check without emitting (tsc --noEmit)
npm run clean        # Remove dist/ directory
```

## Running Tests

```bash
npm test                    # all tests
npm run test:unit           # unit only
npm run test:integration    # integration only
npm run lint                # type-check
```

See [docs/testing.md](docs/testing.md) for test structure, conventions, and the tenets every test must follow.

## Project Structure

```
src/
├── cli.ts              # Entry point — Commander.js program with all commands
├── commands/           # One file per CLI command
│   ├── init.ts
│   ├── status.ts
│   ├── diff.ts
│   ├── describe.ts
│   ├── push.ts
│   ├── pull.ts
│   ├── sync.ts
│   ├── doctor.ts
│   ├── list.ts
│   ├── auth.ts
│   └── update.ts
├── core/               # Core logic (no CLI dependencies)
│   ├── types.ts        # Shared TypeScript interfaces
│   ├── manifest.ts     # Manifest loading + Zod validation
│   ├── state.ts        # State persistence + atomic writes
│   └── engine.ts       # File discovery, hashing, three-way diff
├── display/            # Terminal display utilities
├── llm/                # LLM integration
│   ├── auth.ts         # Copilot token management
│   ├── copilot.ts      # Copilot API client
│   ├── prompts.ts      # Prompt templates for Copilot API
│   └── review.ts       # LLM-assisted file review flow
└── utils/              # Shared utilities
    ├── git.ts          # Git command wrappers (pull, commit, push, diff, status)
    ├── glob.ts         # Glob matching (minimatch)
    ├── hash.ts         # SHA-256 hashing
    └── lock.ts         # File-based lock for concurrent operation prevention
```

See the [Architecture Guide](docs/architecture.md) for detailed module responsibilities.

## How to Add a New Command

1. **Create the command file** at `src/commands/<name>.ts`:

```typescript
import chalk from "chalk";
import { loadManifest } from "../core/manifest.js";

export async function myCommand(options: { flag?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const manifest = loadManifest(cwd);
  // ... command logic
  console.log(chalk.green("✓") + " Done.");
}
```

2. **Register it in `src/cli.ts`**:

```typescript
import { myCommand } from "./commands/my-command.js";

program
  .command("my-command")
  .description("What this command does")
  .option("--flag", "Description of the flag")
  .action(myCommand);
```

3. **Add tests** in `test/unit/my-command.test.ts`.

4. **Document it** in `docs/commands.md`.

## How to Add a New Sync Root Type

Rotunda's sync roots are generic — they map any local directory to any repo directory. To add a new default root (included in `rotunda init`):

1. **Edit the `DEFAULT_MANIFEST`** in `src/commands/init.ts`:

```typescript
const DEFAULT_MANIFEST = {
  version: 1,
  roots: [
    // ...existing roots...
    {
      name: "my-tool",
      local: "~/.my-tool",
      repo: ".my-tool",
      include: ["config/**", "settings.json"],
      exclude: ["cache", "logs", "*.tmp"],
    },
  ],
  // ...
};
```

2. **Test the patterns** — make sure include/exclude patterns correctly filter the tool's directory. Use the glob test suite as a reference.

3. **Update documentation** — add the new root to the default configuration example in `docs/manifest.md`.

## PR Guidelines

- **One logical change per PR.** Keep PRs focused and reviewable.
- **Include tests** for new features and bug fixes — see [docs/testing.md](docs/testing.md) for conventions and the tenets every test must follow.
- **Run the full test suite** before submitting: `npm test`
- **Type-check passes**: `npm run lint`
- **Update docs** if your change affects user-facing behavior.
- **Write a clear PR description** explaining what changed and why.

## Code Style

### Language and Module System

- **TypeScript** with strict mode enabled.
- **ESM** (ECMAScript Modules) — use `import`/`export`, not `require`.
- **`.js` extensions in imports** — TypeScript compiles to `.js`, so imports must use `.js` extensions:

```typescript
// ✅ Correct
import { loadManifest } from "../core/manifest.js";

// ❌ Wrong — will fail at runtime
import { loadManifest } from "../core/manifest";
```

### CLI Output

- Use **chalk** for colored terminal output:
  - `chalk.green("✓")` for success
  - `chalk.yellow("⚠")` for warnings
  - `chalk.red("✗")` or `chalk.red("Error:")` for errors
  - `chalk.dim(...)` for secondary information
  - `chalk.bold(...)` for headings

### General Conventions

- Prefer `async`/`await` over raw promises.
- Use `node:` prefix for built-in modules (`import { readFile } from "node:fs/promises"`).
- Keep functions focused — one function, one responsibility.
- Only comment code that needs clarification. Don't comment the obvious.
- Use descriptive variable names over comments.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
