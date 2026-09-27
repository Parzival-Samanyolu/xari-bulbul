# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Xarı Bülbül ("Harness" internally) is a cross-platform Electron desktop AI coding agent. It is a pnpm monorepo (`node-linker=hoisted`, Node 22+, pnpm 10) and uses no agent framework or AI SDK: the provider adapter and agent loop are hand-written.

## Commands

```bash
pnpm install
pnpm dev                                   # desktop app with hot reload (electron-vite)
HARNESS_DATA_DIR=/tmp/harness-dev pnpm dev # separate profile (settings, keys, sessions)
pnpm typecheck                             # all packages; desktop checks tsconfig.node + tsconfig.web
pnpm test                                  # vitest in packages/core (desktop/cli have no tests)
pnpm build                                 # electron-vite build → apps/desktop/out/
pnpm dist                                  # installers for current OS → apps/desktop/release/

# single test file / single test (run from packages/core)
cd packages/core && npx vitest run test/agent.test.ts
cd packages/core && npx vitest run -t "delegates to a read-only subagent"

# headless engine runner; keys come from <PROVIDER_ID>_API_KEY env vars
OPENROUTER_API_KEY=... pnpm cli --model openrouter:openrouter/free --mode ask
```

CI (`.github/workflows/ci.yml`) runs typecheck, test and build on macOS/Windows/Linux. Pushing a `v*` tag runs `release.yml`, which publishes to GitHub Releases (the publish provider is passed as CLI flags, not in `electron-builder.yml`).

## Architecture

**`packages/core`: the engine, UI-agnostic, consumed as TypeScript source (`main: src/index.ts`, no build step).**
- `providers/openai-compat.ts` is the single adapter for every provider: OpenRouter, Ollama Cloud, local Ollama/LM Studio, and custom ones. It streams SSE, assembles tool calls by index, reports usage (OpenRouter `usage.include` for exact cost), and retries 408/409/429/5xx. `registry.ts` caches model lists. Providers with `requiresKey: false` need no API key.
- `loop/agent.ts`, class `Agent`: one instance per chat. `send()` runs the loop:
  1. model step
  2. tool calls, each passing `Permissions.check`, then either `askPermission` or executing
  3. repeat until done, max steps, budget, or abort

  Everything the UI sees is a typed `AgentEvent` via `onEvent`. `push()` saves the session *before* emitting `message`, because listeners re-read the store.
- **Subagents:** the `task` tool (`tools/task.ts`) calls `ctx.runSubagent`, which the Agent implements. It creates a child `Agent` with a fresh unsaved session, the parent's `Permissions` and usage tracker, usage attributed to the parent session id, and no `task` tool (so no nesting). Consecutive `task` calls run in parallel up to `agent.subagents.maxParallel`. Child approval `callId`s are prefixed `<parentCallId>/<childCallId>`.
- `settings/schema.ts`: a zod schema that is the single source of truth for settings and defaults. Nested objects use `.prefault({})` so partial JSON parses. New settings go here first.
- **Tools** are defined with `defineTool({ name, input: zodSchema, kind, readOnly, subject, execute })` and registered in `tools/index.ts`.
  - `readOnly` tools are always allowed.
  - `subject` is both the UI label and what permission rules like `bash(npm test*)` / `edit_file(src/**)` match against.
  - `edit_file` requires a prior `read_file` of the file in the same agent (`ctx.readFiles`).
- **Extensions** (`extensions/loader.ts`): `~/.harness/{tools/*.mjs,commands/*.md}` and `<project>/.harness/...`. Project *tool code* loads only if `tools.loadProjectExtensions` is on.
- **Storage:**
  - sessions are JSON files (`sessions/store.ts`)
  - usage is JSONL (`usage/tracker.ts`)
  - paths are normalized to NFC, because macOS may hand back decomposed Unicode folder names

**`apps/desktop`: Electron (main / preload / renderer), electron-vite.**
- `src/shared/ipc.ts` is the contract: `AppState` (full snapshot), `UiEvent` (streamed), and `HarnessApi` (exposed as `window.harness` by `preload/index.ts`).
- `src/main/controller.ts` (`AppController`) owns all state.
  - It keeps a `Map<sessionId, Agent>`, so chats keep running while the user views another chat or folder; `activeId` is the chat on screen.
  - Pending approvals are keyed `${sessionId}:${callId}`, because call ids are only unique within a chat.
  - Agent events are forwarded with `sessionId`.
  - `pushState()` sends a fresh `AppState` at turn start/end, on the first message, and on compaction.
  - Background completions and approvals trigger an Electron `Notification` (`main/index.ts`).
  - API keys use `safeStorage` (`main/secrets.ts`).
- **Renderer** (`src/renderer/src`): React 19, plain CSS with OKLCH tokens in `styles.css` (no Tailwind).
  - `App.tsx`'s reducer keeps per-session `lives` (streaming text, live tool state, notices) and applies message and usage events to `app.session` only for the chat on screen.
  - Approvals render inline in the owning tool card (`Chat.tsx`, `owns()`), with a fallback block when no card matches.
- **Packaging gotchas:**
  - `productName` must stay ASCII (`Xari Bulbul`); a non-ASCII productName/CFBundleName makes the packaged macOS app SIGTRAP at launch. The display name `Xarı Bülbül` is set via `mac.extendInfo.CFBundleDisplayName`.
  - HTTP header values (e.g. OpenRouter `X-Title`) must also be ASCII.
  - Electron is pinned to an exact version, as electron-builder requires.

**`apps/cli`**: a minimal REPL over `@harness/core`, used for trying the engine without the UI.

## Testing approach

Core tests use `MockProvider` (`packages/core/test/helpers.ts`), which replays a scripted list of stream events, one list per `chat()` call. Agent-loop, permission, subagent and tool tests run against temp dirs. Desktop changes are verified by typechecking and by driving the running app. For UI checks, launch with `--remote-debugging-port` and a fake OpenAI-compatible server added as a custom provider with `requiresKey: false`.

## Design context

`PRODUCT.md` holds the design brief:
- the register is "product"
- the personality is calm / precise / crafted
- references are Linear and Obsidian
- the accent is velvet plum (hue ~350)
- the UI must meet WCAG AA
- the UI must not look like a Claude/Cursor clone, a SaaS dashboard, or a hacker terminal

Keep UI copy plain and specific.
