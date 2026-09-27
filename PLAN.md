> **Superseded in part:** the build follows `docs/superpowers/specs/2026-09-26-harness-design.md` (hand-written providers, OpenRouter + Ollama Cloud only, no AI SDK). This file is kept as the original roadmap.

# Plan: "Harness" — Cross-platform AI Agentic Coding App

## Context
Build a desktop AI coding agent (in the spirit of Claude Code / Cursor agent) that works on **macOS, Linux, and Windows**, supports **multiple LLM providers**, is distributed through **GitHub** (source and releases), and can grow into a **SaaS** later (accounts, hosted model proxy, billing). `/Users/muradsmacbookair/Harness` is empty, so this is a greenfield build. The first target is a solid MVP plus a phased roadmap.

### Why not Swift
Swift is excellent for a macOS-only app, but SwiftUI doesn't run on Windows or Linux, and cross-platform Swift GUI options are immature. Because the app must ship on all three operating systems, the recommended stack is:

**TypeScript everywhere: Electron + React + Node.** This is the same proven path as VS Code, Cursor, and the Claude desktop app. With one language across the agent core, the UI, and the future SaaS backend, the project gets:
- Mature cross-platform PTY and file APIs
- Auto-update from GitHub Releases
- A large contributor pool

## Architecture (pnpm + Turborepo monorepo)

```
harness/
├─ packages/
│  ├─ core/        # UI-agnostic agent engine (loop, tools, permissions, context, sessions)
│  ├─ providers/   # model abstraction over Vercel AI SDK (Anthropic, OpenAI, Google, OpenRouter, Ollama)
│  ├─ protocol/    # typed event/IPC schemas (zod) shared by core, desktop, cli, server
│  └─ ui/          # React components (chat, diff viewer, permission dialog)
├─ apps/
│  ├─ desktop/     # Electron main + preload + React/Vite renderer
│  ├─ cli/         # headless `harness run "task"` — for testing, CI, power users
│  └─ server/      # (Phase 5) SaaS backend: auth, model proxy, usage metering, billing
└─ .github/workflows/  # CI + release matrix (mac/linux/windows)
```

The core runs in an Electron **utility process**, so the UI never blocks. The core streams typed events (`assistant_delta`, `tool_call`, `permission_request`, `tool_result`, `turn_end`) over IPC to the renderer. The CLI consumes the same event stream.

## Core engine (`packages/core`)
1. **Agent loop:** Send the system prompt, history, and tool schemas; stream the response. When the model requests tool calls, run each one through the permission gate, execute it, append the result, and loop. Stop at `end_turn`, max turns, or user abort (AbortController threaded through everything).
2. **Tools (MVP):**
   - `read_file` (line ranges)
   - `write_file`
   - `edit_file` (exact-string replace, must-be-unique, must-read-first)
   - `list_dir`
   - `glob`
   - `grep` (bundled `@vscode/ripgrep` binary)
   - `bash` (`node-pty`; zsh/bash on Unix, PowerShell or Git Bash on Windows; timeout and output truncation)
   - `web_fetch`
   - `todo_write`

   Each tool is defined as `{name, description, zodSchema, isReadOnly, execute(ctx)}`.
3. **Permissions:**
   - **Modes:** Ask, Auto-accept edits, Plan (read-only), Full auto
   - **Rule lists:** allow/deny patterns (e.g. `bash(npm test:*)`)
   - **Workspace path scoping:** writes outside the workspace root are denied by default
4. **Context management:**
   - Per-provider token counting
   - Auto-compaction: summarize older turns at about 80% of the context window
   - Tool output truncation
   - Anthropic prompt caching breakpoints
   - Loads the project instruction file (`AGENTS.md` / `HARNESS.md`) into the system prompt
5. **Sessions and checkpoints:**
   - Each session is stored as a JSONL transcript in the app data directory, so it can be resumed.
   - Before each edit, a shadow-git snapshot of touched files is taken, so the user can **undo** any turn.
6. **Providers (`packages/providers`):** A thin `ModelProvider` interface on top of the **Vercel AI SDK** (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `ollama-ai-provider`, OpenRouter). The AI SDK already normalizes streaming and tool calls across providers. The interface also exposes per-model capability metadata: context size, tool support, caching, and pricing (for the cost display).

## Desktop app (`apps/desktop`)
- **Electron security:** `contextIsolation: true`, no `nodeIntegration`, typed preload bridge, CSP.
- **Screens:**
  - Workspace picker (open folder)
  - Chat with streaming markdown
  - Tool-call cards with a Monaco **diff viewer** for edits
  - Terminal output panel (xterm.js)
  - Permission prompt dialog
  - Model/provider picker
  - Session sidebar
  - Settings
- **API keys:** Stored with Electron `safeStorage` (OS keychain / DPAPI / libsecret). Nothing is stored in plaintext.
- **Stack:** React + Vite + Tailwind + Zustand.

## GitHub distribution
- **CI** (`ci.yml`): lint, typecheck, and vitest on an `ubuntu`/`macos`/`windows` matrix for every PR.
- **Release** (`release.yml`): on a `v*` tag, electron-builder produces the following and publishes them to **GitHub Releases**:
  - macOS: `.dmg`/`.zip`, universal build
  - Windows: NSIS `.exe`
  - Linux: `.AppImage`/`.deb`/`.rpm`
- **Auto-update:** `electron-updater` pulls from GitHub Releases.
- **Code signing:** Apple Developer ID and notarization (secrets in GH Actions); Windows via Azure Trusted Signing. The app can ship unsigned at first and add signing before the public launch.
- **Repo hygiene:** README with screenshots, LICENSE, CONTRIBUTING, issue templates, Changesets for versioning.

## Roadmap
| Phase | Deliverable |
|---|---|
| 0 | Monorepo scaffold, lint/format/test tooling, CI matrix green |
| 1 | `core` + `providers` + headless `cli` — agent can complete a real coding task end-to-end |
| 2 | Electron desktop app on top of core (chat, diffs, permissions, sessions, settings) |
| 3 | Packaging, signing, auto-update, first GitHub Release (v0.1) |
| 4 | Power features: MCP client, subagents (parallel task tool), hooks (pre/post tool), persistent memory, skills/custom commands, git worktree isolation, optional sandbox (macOS seatbelt / Linux bubblewrap / Windows restricted token) |
| 5 | SaaS layer: `apps/server` (Hono + Postgres/Drizzle), accounts (OAuth), hosted model proxy with usage metering, Stripe billing (BYOK free tier + paid hosted tier), optional cloud session sync |

## Verification
- **Unit tests** (vitest): Each tool runs against a temp directory. The agent loop runs with a **scripted mock provider** that replays canned tool calls, which makes it deterministic and free. Permission-rule matching and compaction are also covered.
- **E2E agent evals:** A small suite of fixture repos with tasks (e.g. "fix failing test", "add endpoint"). `harness run` must make the repo's own test command pass, and the suite runs nightly against real providers.
- **Desktop E2E:** Playwright for Electron covers the golden path (open folder → prompt → approve edit → see diff → undo).
- **Release check:** The CI matrix builds installers on all three operating systems. Each artifact is smoke-installed and launched before the release is published.
