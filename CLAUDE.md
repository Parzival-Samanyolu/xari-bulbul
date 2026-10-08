# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Xarı Bülbül ("Harness" internally) is an AI coding agent for macOS and Linux: an Electron desktop app plus `xb`, a terminal app (Ink) on the same engine (Windows builds are off; `win`/`nsis` config remains in `electron-builder.yml` but nothing builds it). It is a pnpm monorepo (`node-linker=hoisted`, Node 22+, pnpm 10) and uses no agent framework or AI SDK: the provider adapter and agent loop are hand-written.

## Commands

```bash
pnpm install
pnpm dev                                   # desktop app with hot reload (electron-vite)
HARNESS_DATA_DIR=/tmp/harness-dev pnpm dev # separate profile (settings, keys, sessions)
pnpm typecheck                             # all packages; desktop checks tsconfig.node + tsconfig.web
pnpm test                                  # vitest in packages/core and apps/cli (desktop has none)
pnpm build                                 # electron-vite build → apps/desktop/out/
pnpm dist                                  # installers for current OS → apps/desktop/release/

# single test file / single test (run from packages/core)
cd packages/core && npx vitest run test/agent.test.ts
cd packages/core && npx vitest run -t "delegates to a read-only subagent"

# xb, the terminal app, from source (pnpm cli is an alias); `--` separates pnpm's args
pnpm xb                                    # interactive TUI
pnpm xb -- -p "explain this repo" --output-format json
pnpm --filter xari-bulbul-cli build        # esbuild bundle → apps/cli/dist/xb.js
BUN=$(npx -y bun -e 'console.log(process.execPath)') node apps/cli/scripts/build.mjs --compile --targets=bun-darwin-arm64
```

CI (`.github/workflows/ci.yml`) runs typecheck, test and build on macOS and Linux. `release.yml` builds installers and publishes them to GitHub Releases, then its `xb` job adds the terminal binaries (built on macOS for darwin so Bun can sign them, Ubuntu for Linux) and an npm tarball (github.com/Parzival-Samanyolu/xari-bulbul; the publish provider is passed as CLI flags, not in `electron-builder.yml`). Push and tag events have not been triggering workflows in this repo, so start runs manually:

```bash
gh workflow run CI --ref main
gh workflow run Release --ref v0.1.0   # tag must match "version" in apps/desktop/package.json
```

Commits must use the GitHub no-reply address (set in the repo's local git config); GitHub rejects pushes that expose the owner's private email.

## Architecture

**`packages/core`: the engine, UI-agnostic, consumed as TypeScript source (`main: src/index.ts`, no build step).**
- `providers/openai-compat.ts` is the single adapter for every provider: OpenRouter, Ollama Cloud, local Ollama/LM Studio, and custom ones. It streams SSE, assembles tool calls by index, reports usage (OpenRouter `usage.include` for exact cost), and retries 408/409/429/5xx. `registry.ts` caches model lists. Providers with `requiresKey: false` need no API key.
- `loop/agent.ts`, class `Agent`: one instance per chat. `send()` runs the loop:
  1. model step
  2. tool calls, each passing `Permissions.check`, then either `askPermission` or executing
  3. repeat until done, max steps, budget, or abort

  Everything the UI sees is a typed `AgentEvent` via `onEvent`. `push()` saves the session *before* emitting `message`, because listeners re-read the store.
- **Subagents:** the `task` tool (`tools/task.ts`) calls `ctx.runSubagent`, which the Agent implements. It creates a child `Agent` with a fresh unsaved session, the parent's `Permissions` and usage tracker, usage attributed to the parent session id, and no `task` tool (so no nesting). Consecutive `task` calls run in parallel up to `agent.subagents.maxParallel`. Child approval `callId`s are prefixed `<parentCallId>/<childCallId>`.
- `host/`: shared by both apps.
  - `paths.ts`: the data dir is Electron's userData `Xarı Bülbül`, or `HARNESS_DATA_DIR`; also the settings file and env key names.
  - `keychain.ts`: `KeyStore` over macOS `security` / Linux `secret-tool`, with a 0600 file fallback.
    - The service is `xari-bulbul`, or `xari-bulbul-<hash>` for a non-default data dir.
    - Env vars override stored keys.
    - Desktop migrates the old safeStorage `secrets.json` once.
  - `headless.ts`: `runHeadless`.
  - `tools.ts`: `assembleTools`.
  - `providers/catalog.ts`: model-picker logic, also exported as `@harness/core/catalog` for the renderer.
- `settings/schema.ts`: a zod schema that is the single source of truth for settings and defaults. Nested objects use `.prefault({})` so partial JSON parses. New settings go here first.
- **Tools** are defined with `defineTool({ name, input: zodSchema, kind, readOnly, subject, execute })` and registered in `tools/index.ts`.
  - `readOnly` tools are always allowed.
  - `subject` is both the UI label and what permission rules like `bash(npm test*)` / `edit_file(src/**)` match against.
  - `edit_file` requires a prior `read_file` of the file in the same agent (`ctx.readFiles`).
- **Destructive commands** (`permissions/destructive.ts`): `Permissions.check` returns `ask` for `rm`, `git reset --hard`, force pushes etc. in every mode unless a *settings* allow rule matches; `suggestRule()` returns `''` for them, which the UI/CLI treat as allow-once only. Toggle: `permissions.confirmDestructive`.
- **System prompt** (`context/prompt/sections.ts`):
  - small sections with `when()` conditions
  - project instructions nearest-first up to the repo root
  - snapshot-tested per mode
- **Reminders** (`loop/reminders.ts`):
  - hidden `synthetic: 'reminder'` user messages with `<system-reminder>` notes: mode switch, file changed on disk, stale todos, budget, context
  - added only after tool results
- **Parallel tools:** consecutive read-only tool calls run in parallel; results stay in order.
- **Background jobs:** `bash` has `run_in_background`, plus `bash_output` / `kill_job` (`tools/jobs.ts`).
- **Shell writes outside the project** (`outsideWriteReason`) ask in every mode, once at a time, like destructive commands.
- **End-of-turn review:** when the model stops calling tools, `Agent` pushes one `synthetic: 'review'` user message per turn if todos are unfinished or real tool calls failed (malformed calls and user denials don't count; a later success of the same call clears it).
- **Memory** (`memory/store.ts`, `tools/memory.ts`): Markdown bullet lists in `<data>/memory/{global.md,projects/<sha256(NFC cwd)>.md}`, injected into the system prompt. `remember`/`forget` reach it through `ctx.memory`; subagents see memory but don't get the tools.
- **MCP** (`mcp/manager.ts`, `McpManager`): `sync(settings.mcp.servers)` diffs config and (re)connects stdio / Streamable HTTP servers with `@modelcontextprotocol/sdk`; tools become `mcp__<server>__<tool>` with `source: 'mcp'` and `readOnly` from `annotations.readOnlyHint`. The desktop controller merges them after built-ins and extensions (`applyTools()`); HTTP bearer tokens are stored in `SecretStore` as `mcp:<id>`. Tests use `InMemoryTransport` plus a real stdio fixture (`test/fixtures/echo-mcp-server.mjs`).
- **Extensions** (`extensions/loader.ts`): `~/.harness/{tools/*.mjs,commands/*.md}` and `<project>/.harness/...`. Project *tool code* loads only if `tools.loadProjectExtensions` is on.
- **Storage:**
  - sessions are JSON files (`sessions/store.ts`)
  - usage is JSONL (`usage/tracker.ts`)
  - paths are normalized to NFC, because macOS may hand back decomposed Unicode folder names

**`apps/desktop`: Electron (main / preload / renderer), electron-vite.**
- `src/shared/ipc.ts` is the contract: `AppState` (full snapshot), `UiEvent` (streamed), and `HarnessApi` (exposed as `window.harness` by `preload/index.ts`).
- `src/main/controller.ts` (`AppController`) owns all state.
  - It keeps a `Map<sessionId, Agent>`, so chats keep running while the user views another chat or folder; `activeId` is the chat on screen.
  - Several folders are open at once (`settings.app.openWorkspaces`, shown as groups in the sidebar via `AppState.folders`). `workspace` is the folder of the chat on screen; `enterFolder()` switches it, keeps it open, and reloads that folder's extensions. Chats in other folders keep their own tools. `AppState.sessions` stays the current folder's chats (⌘1–9 use it).
  - Pending approvals are keyed `${sessionId}:${callId}`, because call ids are only unique within a chat.
  - Agent events are forwarded with `sessionId`.
  - `pushState()` sends a fresh `AppState` at turn start/end, on the first message, and on compaction.
  - Background completions and approvals trigger an Electron `Notification` (`main/index.ts`).
  - API keys live in the OS keychain through core `KeyStore` (`main/secrets.ts`); `safeStorage` is only the fallback without a keychain, and the source of the one-time migration.
  - `main/shell-path.ts` loads `PATH` from the login shell at startup, so `npx`/`uvx` MCP servers and `bash` find user-installed tools when launched from the Dock.
- **Renderer** (`src/renderer/src`): React 19, plain CSS with OKLCH tokens in `styles.css` (no Tailwind).
  - `App.tsx`'s reducer keeps per-session `lives` (streaming text, live tool state, notices) and applies message and usage events to `app.session` only for the chat on screen.
  - Approvals render inline in the owning tool card (`Chat.tsx`, `owns()`), with a fallback block when no card matches.
- **Packaging gotchas:**
  - `productName` must stay ASCII (`Xari Bulbul`); a non-ASCII productName/CFBundleName makes the packaged macOS app SIGTRAP at launch. The display name `Xarı Bülbül` is set via `mac.extendInfo.CFBundleDisplayName`.
  - HTTP header values (e.g. OpenRouter `X-Title`) must also be ASCII.
  - Electron is pinned to an exact version, as electron-builder requires.
  - `packaging/arch/xb/PKGBUILD` (`xari-bulbul-cli-bin`) installs the `xb` binary; keep `!strip`, since stripping breaks Bun binaries.
  - Linux package names come from `deb.packageName` / `pacman.packageName` (`xari-bulbul`); without them fpm uses `productName`, and pacman rejects names with spaces. The pacman target needs `bsdtar` (installed in `release.yml` on Linux). `packaging/arch/PKGBUILD` needs `pkgver` and `sha256sums` updated for each release.
  - A local `pnpm dist` puts a `.app` in `apps/desktop/release/`, which Launchpad shows as a second copy of the app; delete `release/` after local Mac builds.

**`apps/cli`: `xb`, the terminal app (Ink 8 + React 19).** Plan and decisions are in `PLAN-CLI.md`.
- `src/cli.tsx` `runCli(argv, io)`:
  - subcommands: chat, `-p`/`exec` (headless via core `runHeadless`), `login`, `--version`
  - exit codes: 0 / 1 / 2 usage / 3 budget / 4 max steps / 130
- `src/host.ts` `Host`:
  - the engine wiring for one chat: settings, `KeyStore`, registry, sessions, usage, memory, MCP and extensions
  - `updateSettings` re-reads settings.json first, so desktop edits aren't clobbered
- `src/ui/App.tsx` (the turn state machine):
  - finished cells go to Ink `<Static>` (terminal scrollback); only the live area redraws
  - slash commands are in `runCommand`
  - approvals come from `askPermission` promises
- `src/theme/`:
  - `tokens.ts` mirrors the desktop OKLCH tokens; a test keeps them equal to `styles.css`
  - `orchid.generated.ts` comes from `scripts/make-orchid.mjs`
- Tests use ink-testing-library, the core `MockProvider`, and a local SSE server for `runCli`.
- Visual checks: drive `dist/xb.js` in a pty with pyte (no tmux on this machine).

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
