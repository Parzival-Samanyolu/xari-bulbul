<p align="center"><img src="docs/brand/logo-oled-1024.png" width="180" alt="Xarı Bülbül logo: a Caucasian bee-orchid on black"></p>

# Xarı Bülbül

*Xarı bülbül* is a flower from Karabakh, and this is an AI coding agent.

A desktop AI coding agent for **macOS, Windows and Linux** that works directly in your project.
It reads, searches, edits and runs code, and it can use **any model** on OpenRouter, Ollama Cloud, or any OpenAI-compatible API.

Built to be owned and extended. The engine is small, readable TypeScript with no agent framework and no AI SDK.

## Features

- **Claude Code–style agent loop:**
  - tools for read, edit (exact-match replace), write, list, glob, grep, shell, web fetch and a todo list
  - a diff for every edit
  - live streaming, Stop / Esc, and resumable chats
- **One-step model switching:** press ⌘/Ctrl+K to switch models, even mid-conversation. The switcher:
  - opens on **free models only** by default (18 of OpenRouter's ~460)
  - puts your favorites and recently used models on top
  - sorts by newest, name, context or price
  - is a click away from the full catalog

  The default model is `openrouter/free`, which lets OpenRouter pick an available free model for you.
- **Token, request and cost tracking:**
  - live in the status bar: prompt/completion/cached tokens, requests, and cost per chat and per day
  - a context-window meter
  - a per-model breakdown, CSV export, and per-chat or daily budgets (warn or stop)
- **Permission modes:** Ask / Auto-edit / Plan (read-only) / Full auto, plus allow and deny rules like `bash(npm test*)` or `edit_file(src/**)`. Writes outside the project folder always ask.
- **Detailed settings:**
  - Providers & keys: stored with OS-encrypted storage
  - Models: defaults, per-model overrides, reasoning effort
  - Agent: custom instructions, system prompt override, compaction, timeouts, shell
  - Tools, Usage, Appearance, and settings import/export for your team
- **Parallel chats:** chats keep working while you switch to another chat or folder. The sidebar shows which chats are working or need approval, and you get a notification when a background chat finishes.
- **Subagents:** the agent can hand wide searches or independent jobs to subagents that start with a fresh context and run in parallel. Only their reports come back to the chat. You can set their model, how many run at once, and whether they may edit.
- **Automatic context compaction:** long conversations are summarized when the context window fills up. `AGENTS.md` / `HARNESS.md` / `CLAUDE.md` project instructions are loaded automatically.
- **Extensions:** add your own tools (`.mjs`) and slash commands (`.md`), and add any OpenAI-compatible provider.
- **Auto-updates** from GitHub Releases.

## Quick start

Requires Node 22+ and pnpm 10.

```bash
pnpm install
pnpm dev          # launches the desktop app with hot reload
```

1. Open **Settings → Providers & Keys** and paste an [OpenRouter](https://openrouter.ai/keys) or [Ollama Cloud](https://ollama.com/settings/keys) key, then click **Test**.
2. Open a project folder and start asking.

| Shortcut | Action |
|---|---|
| ⌘/Ctrl+K | Model switcher |
| ⌘/Ctrl+N | New chat |
| ⌘/Ctrl+, | Settings |
| Shift+Tab | Cycle permission mode |
| Esc | Stop the agent |
| `/` | Slash commands (`/compact`, `/clear`, `/model`, `/mode`, plus yours) |

To keep a development profile separate from your real one:

```bash
HARNESS_DATA_DIR=/tmp/harness-dev pnpm dev
```

### Headless dev CLI

This CLI is for testing the engine and trying models quickly:

```bash
OPENROUTER_API_KEY=sk-or-... pnpm cli --model openrouter:openrouter/free --mode ask
OLLAMA_CLOUD_API_KEY=... pnpm cli --model ollama-cloud:glm-5.3 "explain this repo"
```

## Extending Xarı Bülbül

Extensions live in `~/.harness/` (yours, applied to every project) or `<project>/.harness/` (per project):

```
.harness/
├─ tools/       *.mjs  → new tools the model can call
└─ commands/    *.md   → slash commands (/name), with $ARGUMENTS substitution
```

See [`examples/extensions`](examples/extensions) for a working tool and two commands. Reload them from **Settings → Tools & Extensions**.

Project *tool code* only loads if you enable it in settings, because opening a cloned repo shouldn't run its code. Project commands, which are plain markdown, always load.

To add a provider, go to **Settings → Providers → Add a custom provider** and enter any OpenAI-compatible base URL, such as:
- local Ollama: `http://localhost:11434/v1`
- LM Studio
- Groq
- DeepSeek
- vLLM

## Project layout

```
packages/core/          the engine: no UI, fully tested
  src/providers/        OpenAI-compatible streaming adapter, SSE parser, model registry
  src/loop/agent.ts     the agent loop (events, permissions, tool execution, compaction)
  src/tools/            one file per built-in tool
  src/permissions/      modes + allow/deny rule matching
  src/usage/            token/request/cost tracking and budgets
  src/sessions/         chat persistence
  src/context/          system prompt, project instructions, compaction
  src/extensions/       user tools and slash commands
  src/settings/         the settings schema (zod) with defaults
apps/desktop/           Electron app: main process (controller, IPC, keys, updater) + React UI
apps/cli/               headless dev runner
```

To add a built-in tool, create one file in `packages/core/src/tools/` using `defineTool(...)` and register it in `tools/index.ts`.

## Tests

```bash
pnpm test         # vitest: provider streaming, tools, permissions, usage, agent loop (mock provider)
pnpm typecheck
```

## Building installers and releasing

```bash
pnpm dist         # builds installers for the current OS into apps/desktop/release/
```

Pushing a tag like `v0.1.0` runs `.github/workflows/release.yml`. It builds on macOS, Windows and Linux and publishes these files to a GitHub Release, which installed apps auto-update from:
- macOS: `.dmg` and `.zip`
- Windows: `.exe`
- Linux: `.AppImage` and `.deb`

Builds are **unsigned** until you add signing secrets (see the comments in the workflow). Without signing:
- On macOS, right-click the app and choose **Open** the first time.
- On Windows, SmartScreen asks you to click **More info → Run anyway**.

## Roadmap

- Undo / checkpoints per turn
- MCP client
- Hooks
- Persistent memory
- Sandboxed shell
- Code signing
- Team settings sync

## Credits

The logo is an edit of a public-domain photo of *Ophrys caucasica* by Nuvens on Wikimedia Commons. See [docs/brand](docs/brand/README.md).

## License

MIT
