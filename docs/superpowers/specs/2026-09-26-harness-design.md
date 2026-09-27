# Harness — Design Spec (MVP)

## Intent
Personal/team AI coding agent, published openly on GitHub. The owner wants to understand and extend every part.
Must-haves: Claude Code–like agent experience, **one-click model switching**, **live token / request / cost counts**, **extensive settings**, and runs on macOS, Linux, and Windows as a **desktop window app**.

## Decisions
| Area | Decision |
|---|---|
| Stack | TypeScript. pnpm monorepo: `packages/core` (engine, no UI), `apps/desktop` (Electron + React), `apps/cli` (dev/test runner) |
| Providers | **OpenRouter** + **Ollama Cloud** only, both via one hand-written `OpenAICompatProvider` (`/chat/completions` SSE, `/models`). Extra OpenAI-compatible providers can be added in settings. No AI SDK or agent framework. No direct Anthropic |
| Endpoints | OpenRouter `https://openrouter.ai/api/v1`; Ollama Cloud `https://ollama.com/v1` (verified to speak the OpenAI format) |
| Messages | Neutral OpenAI-shaped history (`system`/`user`/`assistant{toolCalls}`/`tool`), so switching models mid-session just works |
| Loop | stream → run tool calls sequentially through the permission gate → repeat until no tool calls. Stops at max steps, abort, or budget limit. Emits typed `AgentEvent`s; UI-agnostic |
| Tools | `read_file`, `write_file`, `edit_file` (exact unique match, must read first), `list_dir`, `glob`, `grep`, `bash`, `web_fetch`, `todo_write`. Each is one file |
| Permissions | Modes `ask` / `acceptEdits` / `plan` / `auto`. Allow/deny rules like `bash(npm test*)` and `write_file(src/**)`. Writes outside the workspace always ask. Ask → allow once / always (session) / deny with feedback |
| Usage | Every request is recorded (provider, model, prompt/completion/cached tokens, cost). Cost comes from OpenRouter `usage.cost`, falling back to model pricing × tokens. Totals for session, today, all time, and per model. Optional session and daily USD budgets (warn/stop). Stored as JSONL |
| Context | Tool output is capped. Auto-compaction summarizes older turns when prompt tokens exceed N% (default 80%) of the context window. Project instructions come from `AGENTS.md` / `HARNESS.md` / `CLAUDE.md` |
| Model picker | Free-only filter on by default. Favorites and recents on top. Sort by newest, name, context or price. Default model `openrouter/free`. The owner mostly uses free models, and the full catalog (~460) is too big to browse |
| Sessions | One JSON file per session (metadata + messages) in the app data dir. Can be resumed |
| Extensions | `~/.harness/` and `<project>/.harness/`: `tools/*.mjs` (a plain JS tool with a JSON-schema `parameters`), `commands/*.md` (slash commands with `$ARGUMENTS`), plus custom providers in settings |
| Settings | Tabbed settings screen: Providers, Models, Agent, Permissions, Tools, Usage & Budgets, Appearance, Data, About/Updates. Shared zod schema in core. API keys are encrypted with Electron `safeStorage`, never sent to the renderer |
| Desktop | Agent runs in the Electron main process. Typed preload bridge, `contextIsolation`, no `nodeIntegration`, CSP, and markdown sanitized with DOMPurify |
| Distribution | GitHub Actions CI (mac/linux/windows: typecheck + tests). Tag-triggered electron-builder release to GitHub Releases (dmg/zip, nsis, AppImage/deb) with electron-updater |

## Deferred (roadmap)
Per-turn undo/checkpoints, MCP client, subagents, hooks, memory, sandboxing, signing/notarization, SaaS/team sync.

## Testing
vitest in core:
- SSE parsing and tool-call assembly (mocked fetch)
- agent loop with a scripted mock provider
- tools against temp directories
- permission rule matching
- usage aggregation and budgets
- compaction split boundaries

Desktop: typecheck plus a manual smoke run.
