<p align="center"><img src="docs/brand/logo-oled-1024.png" width="180" alt="Xarı Bülbül logo: a Caucasian bee-orchid on black"></p>

# Xarı Bülbül

*Xarı bülbül* is a flower from Karabakh, and this is an AI coding agent.

An AI coding agent for **macOS, Windows and Linux** that works directly in your project, as a desktop app.
It reads, searches, edits and runs code, and it can use **any model** on OpenRouter, Ollama Cloud, Google AI Studio (Gemini), or any OpenAI-compatible API.

Built to be owned and extended. The engine is small, readable TypeScript with no agent framework and no AI SDK.

## Features

- **Claude Code–style agent loop:**
  - tools for read, edit (exact-match replace), write, list, glob, grep, shell, web search, web fetch and a todo list
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
- **Destructive commands always ask:** `rm`, `git reset --hard`, force pushes and similar need your approval even in Full auto, and are only ever allowed once. Before a turn ends, the agent checks for unfinished checklist steps and failed tool calls and must report anything it skipped.
- **Web search:**
  - **No key needed:** DuckDuckGo first, then Brave's free search when DuckDuckGo is busy. Results unrelated to the query are rejected.
  - **Free keys (optional):** a Brave Search key (2,000 searches a month) or a Tavily key (1,000 a month) is used first in automatic mode. Add one in **Settings → Tools** or by setting `BRAVE_API_KEY` / `TAVILY_API_KEY`.
  - **Your own SearXNG:** also supported.
  - **Filters:** searches can be limited to certain sites and to recent results.
  - **Reading pages:** `web_fetch` returns a page's main content as Markdown, in parts for long pages.
- **MCP servers:** connect local (command) or remote (URL) Model Context Protocol servers in **Settings → MCP Servers**. Their tools follow your permission rules as `mcp__<server>__<tool>`. GitHub's hosted server is one click: **Add GitHub**, then paste a token.
- **Memory:** the agent can remember facts across chats (your preferences, how to test a project) with the `remember` / `forget` tools. Memories live in the app's data folder, and you can review or delete them in **Settings → Memory**.
- **Detailed settings:**
  - Providers & keys: stored in the OS keychain (macOS Keychain, libsecret on Linux), or encrypted with your Windows account (DPAPI)
  - Models: defaults, per-model overrides, reasoning effort
  - Agent: custom instructions, system prompt override, compaction, timeouts, shell
  - Tools, Usage, Appearance, and settings import/export for your team
- **Several folders at once:** the sidebar lists every open folder with its chats. Chats keep working while you look at another chat or folder; the sidebar shows which are working or need approval (a dot on collapsed folders), and you get a notification when a background chat finishes.
- **Subagents:** the agent can hand wide searches or independent jobs to subagents that start with a fresh context and run in parallel. Only their reports come back to the chat. You can set their model, how many run at once, and whether they may edit.
- **Automatic context compaction:** long conversations are summarized when the context window fills up. `AGENTS.md` / `HARNESS.md` / `CLAUDE.md` project instructions are loaded automatically.
- **Extensions:** add your own tools (`.mjs`) and slash commands (`.md`), and add any OpenAI-compatible provider.
- **Auto-updates** from GitHub Releases.

## Install

Download the latest installer from [Releases](https://github.com/Parzival-Samanyolu/xari-bulbul/releases/latest):

| System | File |
|---|---|
| macOS (Apple silicon and Intel) | `.dmg` |
| Windows (x64) | `.exe` |
| Linux (x64, any distro) | `.AppImage`: `chmod +x XariBulbul-*.AppImage` and run it |

Arch Linux users can also build a package from the [`PKGBUILD`](packaging/arch).

## Quick start (from source)

Requires Node 22+ and pnpm 10.

```bash
pnpm install
pnpm dev          # launches the desktop app with hot reload
```

1. Open **Settings → Providers & Keys** and paste an [OpenRouter](https://openrouter.ai/keys) or [Ollama Cloud](https://ollama.com/settings/keys) or [Google AI Studio](https://aistudio.google.com/apikey) key, then click **Test**.
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
  src/mcp/              MCP client: connects servers, adapts their tools
  src/memory/           facts saved across chats
  src/settings/         the settings schema (zod) with defaults
apps/desktop/           Electron app: main process (controller, IPC, keys, updater) + React UI
bench/                  model benchmark: tasks, runner, published results
```

To add a built-in tool, create one file in `packages/core/src/tools/` using `defineTool(...)` and register it in `tools/index.ts`.

## Tests

```bash
pnpm test         # vitest: engine (mock provider, prompt snapshots, headless runs)
pnpm typecheck
```

## Model benchmark

[`bench/`](bench) runs agent tasks (coding, tool use, GitHub MCP) through the real engine and checks the results. See [the latest results](bench/README.md#latest-results), also published as the Hugging Face dataset [Parizival/xari-bulbul-bench](https://huggingface.co/datasets/Parizival/xari-bulbul-bench). Run `pnpm bench` to benchmark your own favorite models.

## Building installers and releasing

```bash
pnpm dist         # builds installers for the current OS into apps/desktop/release/
```

Pushing a tag like `v0.1.0` runs `.github/workflows/release.yml`. It builds on macOS, Windows and Linux and publishes these files to a GitHub Release, which installed apps auto-update from:
- macOS: `.dmg` (plus the `.zip` the updater installs from)
- Windows: `.exe`
- Linux: `.AppImage`
- the `latest*.yml` files the updater reads

On Arch Linux, the `PKGBUILD` in [`packaging/arch`](packaging/arch) repackages the AppImage.

Builds are **unsigned** until you add signing secrets (see the comments in the workflow). Without signing:
- On macOS, right-click the app and choose **Open** the first time.
- On Windows, SmartScreen asks you to click **More info → Run anyway**.

## Roadmap

- Undo / checkpoints per turn
- OAuth sign-in for remote MCP servers
- Hooks
- Sandboxed shell
- Code signing
- Team settings sync

## Credits

The logo is an edit of a public-domain photo of *Ophrys caucasica* by Nuvens on Wikimedia Commons. See [docs/brand](docs/brand/README.md).

## License

MIT
