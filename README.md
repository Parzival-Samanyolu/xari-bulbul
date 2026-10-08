<p align="center"><img src="docs/brand/logo-oled-1024.png" width="180" alt="Xarı Bülbül logo: a Caucasian bee-orchid on black"></p>

# Xarı Bülbül

*Xarı bülbül* is a flower from Karabakh, and this is an AI coding agent.

An AI coding agent for **macOS and Linux** that works directly in your project, as a desktop app or in your terminal (`xb`).
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
- **Destructive commands always ask:** `rm`, `git reset --hard`, force pushes and similar need your approval even in Full auto, and are only ever allowed once. Before a turn ends, the agent checks for unfinished checklist steps and failed tool calls and must report anything it skipped.
- **MCP servers:** connect local (command) or remote (URL) Model Context Protocol servers in **Settings → MCP Servers**. Their tools follow your permission rules as `mcp__<server>__<tool>`.
- **Memory:** the agent can remember facts across chats (your preferences, how to test a project) with the `remember` / `forget` tools. Memories live in the app's data folder, and you can review or delete them in **Settings → Memory**.
- **Detailed settings:**
  - Providers & keys: stored in the OS keychain (macOS Keychain, libsecret on Linux), shared with `xb`
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
| Arch Linux / Manjaro | `.pacman`: `sudo pacman -U XariBulbul-*-linux-x64.pacman` |
| Debian / Ubuntu | `.deb` |
| Other Linux | `.AppImage` |

## Terminal: `xb`

`xb` is Xarı Bülbül in your terminal. It runs the same engine as the desktop app and shares its settings, chats, usage history, memory and keys.

```bash
xb                         # start a chat in the current folder
xb "fix the failing test"  # start with a first message
xb -c                      # continue the latest chat in this folder
xb --resume                # pick an earlier chat (or: xb --resume <id>)
xb login                   # save an API key in the OS keychain and test it
xb -p "summarize the README" --output-format json   # one turn, no UI
```

**Install:** download `xb-<version>-<platform>.tar.gz` from [Releases](https://github.com/Parzival-Samanyolu/xari-bulbul/releases/latest). It is a single binary with no dependencies.
- macOS on Apple silicon: `darwin-arm64`
- macOS on Intel: `darwin-x64`
- Linux: `linux-x64`

Put `xb` on your `PATH`. With Node 22+ you can instead install `xb-<version>.tgz` from the same release with `npm install -g`. On Arch, use [`packaging/arch/xb/PKGBUILD`](packaging/arch/xb/PKGBUILD).

**The screen:** finished messages go into your terminal's normal scrollback. Only the bottom of the screen redraws:
- the "Working" line
- approvals
- popups
- the prompt
- a footer with the mode, model, context use, tokens and cost

Command output is condensed (Ctrl+O expands it), and edits show as numbered, coloured diffs.

**Colours:** the colours are Xarı Bülbül's plum palette, read from the desktop theme. `xb` detects whether your terminal is light or dark, falls back from truecolor to 256 and then 16 colours, respects `NO_COLOR`, and works at 80×24.

| Key | Action |
|---|---|
| Enter | send (queues a follow-up while the agent works) |
| Shift+Enter, Ctrl+J, or `\` then Enter | new line |
| Shift+Tab | cycle Ask → Auto-edit → Plan → Full auto |
| Ctrl+K or `/model` | switch model; opens on free models, favorites and recents first |
| Esc | interrupt the agent, or close a popup |
| Ctrl+C | clear the prompt; press twice to quit (the chat is saved) |
| ↑ / ↓ | prompt history |
| `@path` | mention a file; its contents are attached |
| `?` | all shortcuts |

**Commands:** `/model`, `/mode`, `/compact`, `/clear`, `/resume`, `/status`, `/usage` (`/usage csv` exports), `/memory`, `/mcp`, `/init` (writes an `AGENTS.md`), `/login`, `/help`, `/exit`. Your own commands from `~/.harness/commands` and `<project>/.harness/commands` appear in the same popup.

**Headless runs:** `xb -p` answers nobody's approval prompts, so anything that would ask is denied and reported. Choose the mode and allow rules up front, for example `--mode full-auto`. Destructive commands are still refused.

Exit codes:
- 0 done
- 1 error
- 2 bad usage or missing key
- 3 budget reached
- 4 step limit
- 130 interrupted

`--output-format json` prints one result object with the answer, exact usage and cost, and denied actions. `stream-json` prints every event as a JSON line.

**Keys and data:**
- **Keys:** `<PROVIDER>_API_KEY` environment variables (`OPENROUTER_API_KEY`, `OLLAMA_CLOUD_API_KEY`, …) override stored keys.
- **Data:** stored in the desktop app's data folder: `~/Library/Application Support/Xarı Bülbül` on macOS, `~/.config/Xarı Bülbül` on Linux.
- **Separate profile:** `HARNESS_DATA_DIR` selects a separate profile, which also gets its own keychain entries.

## Quick start (from source)

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

### Terminal app from source

```bash
pnpm xb                                      # the terminal app, run from source
pnpm xb -- -p "explain this repo" --mode plan
pnpm --filter xari-bulbul-cli build          # bundle to apps/cli/dist/xb.js
```

> **Migrating from the old dev CLI:** `pnpm cli` now starts `xb`.
> - The old `--model provider:model` and `--mode` flags still work, and a positional prompt still sends a first message.
> - For one-shot runs without the UI, use `-p`.
> - The old CLI stored chats in `~/.harness/cli`. `xb` uses the shared data folder instead.

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
apps/cli/               xb, the terminal app (Ink): UI in src/ui, theme and orchid in src/theme
```

To add a built-in tool, create one file in `packages/core/src/tools/` using `defineTool(...)` and register it in `tools/index.ts`.

## Tests

```bash
pnpm test         # vitest: engine (mock provider, prompt snapshots) and xb (Ink components, headless runs)
pnpm typecheck
```

## Building installers and releasing

```bash
pnpm dist         # builds installers for the current OS into apps/desktop/release/
```

Pushing a tag like `v0.1.0` runs `.github/workflows/release.yml`. It builds on macOS and Linux and publishes these files to a GitHub Release, which installed apps auto-update from:
- macOS: `.dmg` and `.zip`
- Linux: `.AppImage`, `.deb` and `.pacman` (Arch Linux)
- `xb`: single binaries for macOS (arm64, x64) and Linux (x64), plus an npm tarball

On Arch Linux, install the `.pacman` file with `sudo pacman -U XariBulbul-<version>-linux-x64.pacman`, or use the `PKGBUILD` in [`packaging/arch`](packaging/arch).

Builds are **unsigned** until you add signing secrets (see the comments in the workflow). Without signing:
- On macOS, right-click the app and choose **Open** the first time.

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
