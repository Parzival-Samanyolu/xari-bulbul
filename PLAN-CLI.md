# Plan: `xb` — the terminal version of Xarı Bülbül

## Context
Xarı Bülbül has an engine (`packages/core`) and the Electron desktop app. The current terminal tool, `apps/cli`, is only a 116-line readline dev runner. It uses its own data dir (`~/.harness/cli`), does not read settings.json, has no MCP and no sessions.

The goal is `xb`, a real terminal product:
- Codex-CLI layout: inline Ink rendering, with history going to scrollback.
- Claude-Code behavior underneath.
- Any provider, free-first.
- Xarı Bülbül's orchid, plum palette and ideals.

It must use the same engine as desktop, and desktop must keep working. The first step of execution copies this plan into the repo as `PLAN-CLI.md`, in PLAN.md's style. Decisions are recorded there as they are made.

## Recorded decisions
- **Package:** `apps/cli` becomes the `xb` app. The package is renamed `xari-bulbul-cli`, with `bin: { xb }`. `pnpm cli` keeps working and runs the new TUI. The old readline runner is removed, and README gets a migration note.
- **Stack:** Ink 6, React 19 (the same major as desktop), and ink-testing-library. String-width handling comes from Ink. No other UI libs except `chalk` (color levels), plus `diff`, which core already has.
- **Build:**
  - The npm package is bundled with esbuild into `dist/xb.js`; core is inlined.
  - Release binaries come from `bun build --compile` in CI, using `oven-sh/setup-bun`. Targets: `bun-darwin-arm64`, `bun-darwin-x64` and `bun-linux-x64`, all cross-compiled on one runner.
  - Locally, use `npx bun` because bun isn't installed.
- **Data dir:**
  - Shared with desktop. `resolveDataDir()` returns `HARNESS_DATA_DIR`, or `~/Library/Application Support/Xarı Bülbül` on macOS, or `${XDG_CONFIG_HOME:-~/.config}/Xarı Bülbül` on Linux.
  - The exact names are verified against Electron's userData on disk.
  - That shares settings.json, sessions, usage.jsonl and memory.
- **Keys, shared with desktop:**
  - New core module `src/host/keychain.ts` provides `KeychainStore`.
    - macOS: the `security` CLI (`add-generic-password -U` / `find-generic-password -w`), service `xari-bulbul`, account = secret id.
    - Linux: `secret-tool` (libsecret), attributes `service xari-bulbul id <id>`.
    - Both use `execFile` with no shell. Secrets go in through argv on macOS and through stdin for secret-tool. On macOS, `security -w` taking the password on argv is a known limitation; this is documented.
  - **Desktop migration** (`apps/desktop/src/main/secrets.ts`): `SecretStore` becomes keychain-backed.
    - On first launch it decrypts each `secrets.json` entry with safeStorage and writes it to the keychain.
    - Only after every entry verifies does it rename `secrets.json` → `secrets.json.migrated`.
    - If the keychain is unavailable (Linux without libsecret), desktop keeps safeStorage and `xb` falls back to a `0600` `xb-secrets.json`. Both UIs say which storage is in use.
  - `<PROVIDER>_API_KEY` env vars override everything; MCP tokens stay `mcp:<id>`.
  - No native dependencies, so `bun --compile` stays clean.
  - Tests use an injected fake `exec`.
- **Settings:** the existing zod schema gets a new `cli` section with `.prefault({})`: `theme: auto|dark|light`, `showLogo`, `editor`.
- **Codex study:** shallow-clone `openai/codex` into `/tmp/codex-src` (read-only reference). Any adapted text keeps the Apache-2.0 notice in `apps/cli/NOTICE`. The aim is to reproduce layout and behavior, not to port code.

## Part A: Core engine work (each item gets tests in `packages/core/test`)
1. **Host plumbing (`src/host/`):**
   - `resolveDataDir`, `loadSettingsFile` / `saveSettingsFile` (moved from `controller.ts:123-138`; desktop then calls them).
   - `envKey(providerId)`, which dedups the env-key code in cli and `secrets.ts`.
   - `latestSession(store, cwd)`.
   - `assembleTools(builtin, ext, mcp)`, moved from `applyTools` in `controller.ts`.
2. **Model catalog helpers (`src/providers/catalog.ts`):** `sortModels`, `displayName`, `matchesQuery` and `pickerSections(current, favorites, recents)`, moved out of `ModelPicker.tsx` so the TUI and desktop share them. `ModelPicker.tsx` imports them.
3. **Parallel read-only tools:**
   - In `agent.ts`, consecutive calls whose tool is `readOnly` and whose verdict is `allow` run concurrently, together with `task` calls, capped at 8.
   - Results are pushed in the original order.
4. **Layered system prompt (`src/context/prompt/`):**
   - Small section modules, each with a `when(input)` condition:
     - identity
     - tone
     - doing-tasks
     - proactiveness
     - conventions
     - tool-policy
     - safety-secrets
     - git
     - mode blocks for plan, acceptEdits and auto
     - environment: cwd, git branch and short status, OS, shell, date, model, context size
     - project instructions
     - memory
     - custom instructions
   - Project instructions read AGENTS.md, HARNESS.md and CLAUDE.md, nearest first, walking up to the git root.
   - Longer, rule-rich tool descriptions are written fresh.
   - `buildSystemPrompt` keeps its signature.
   - Snapshot tests cover each of the 4 modes and the subagent prompt, with date, OS and cwd frozen.
5. **`<system-reminder>` injections:**
   - Before each model step, `Agent` appends a synthetic user note to the *outgoing request only*. It is never shown in the UI and never saved twice, and is tagged `synthetic: 'reminder'`. Triggers:
     - todo nudge: no todo update for N steps while items are open
     - file changed on disk: the mtime of a file in `readFiles` moved since it was read
     - mode switched
     - budget at 80% or more
     - context at 70% or more, before compaction
   - Tested with MockProvider by inspecting `requests`.
6. **Shell:**
   - `bash` gains `run_in_background` and returns a job id.
   - New `bash_output(job_id)` (read-only) and `kill_job(job_id)`.
   - Jobs live in `ctx.jobs` per agent and are killed on agent dispose.
7. **Permissions:**
   - The four modes stay (`ask` / `acceptEdits` / `plan` / `auto`).
   - Tests confirm destructive commands ask in `auto`, and that "always" is never offered for them.
   - Writes outside the project ask in `auto`.
   - `bash` redirects into absolute paths outside the cwd (`> /etc/x`, `tee /x`) ask. This uses simple detection in `destructive.ts`'s new `outsideWriteReason`.
8. **Usage:** `usage.byDay()` and `usage.bySession()` aggregations, plus a CSV that already exists.
9. **Headless runner (`src/host/headless.ts`):**
   - `runHeadless({prompt, model, mode, format})` emits text, json or stream-json and returns an exit code:
     - 0 done
     - 1 error
     - 2 bad usage
     - 3 budget
     - 4 max_steps
     - 130 interrupted
   - Permission asks are denied unless the mode allows them (there is no TTY to ask).
   - Tested with MockProvider.

## Part B: `apps/cli` TUI (Ink)
Structure under `apps/cli/src/`:
- `main.tsx`: argument parsing (`node:util parseArgs`).
  - Subcommands: `xb`, `xb -p "…"` / `xb exec "…"`, `--output-format`, `-c/--continue`, `-r/--resume [id]`, `-m/--model`, `--mode`, `xb login`, `xb --version`.
- `host.ts`: wires registry, keychain secrets, settings, sessions, usage, memory, MCP and extensions. It is a slim mirror of `AppController` for one chat at a time.
- `theme/`: `tokens.ts` (OKLCH → sRGB conversion at build time, generated into a table), `palette.ts` and `logo.ts`.
  - Light and dark come from `COLORFGBG` / settings.
  - Color support is truecolor → 256 → 16. `NO_COLOR` makes everything monochrome, with bold and dim only.
- `ui/`:
  - `App.tsx`
  - `Header.tsx`: rounded box with the orchid, "Xarı Bülbül vX", model, directory and mode.
  - `History.tsx`: `<Static>` cells for user, assistant markdown, tool and diff.
  - `Markdown.tsx`: a small terminal markdown renderer for headings, lists, code fences and inline code.
  - `ExecCell.tsx`: the command, the first and last lines of output, the exit status and duration. Ctrl+O expands the last cell.
  - `DiffCell.tsx`: file header with +N −M and colored hunks using the add/del tokens.
  - `Composer.tsx`:
    - multi-line editing with Shift+Enter or `\` then Enter for a newline
    - ↑/↓ history saved to `<data>/xb-history`
    - bracketed paste, with large pastes collapsed to `[Pasted N lines]`
    - `@` file mentions using core `findFiles`
    - `/` popup with fuzzy filtering
  - `Footer.tsx`: key hints on the left; model, mode, tokens, cost and a context meter on the right.
  - `Status.tsx`: "Working (12s · Esc to interrupt)" with a quiet spinner in plum.
  - `Approval.tsx`: an inline overlay with **1** Yes once, **2** Yes, always allow `rule` (hidden for destructive commands), and **3** No, tell Xarı Bülbül why.
  - `popups/`: ModelPicker, Resume, Status, Mcp, Usage, Help and Memory, all using one `Popup` list primitive.
    - The model picker opens with free models only, then favorites, then recents.
    - `s` cycles sort; `a` toggles the full catalog; `f` toggles favorite.
- Keys:
  - Shift+Tab cycles the mode.
  - Ctrl+K opens the model picker.
  - Esc interrupts, or closes the popup.
  - Ctrl+C clears the input, and a second Ctrl+C exits.
  - Ctrl+L redraws.
- Slash commands:
  - Built in: /model /mode /compact /clear /resume /status /usage (with `/usage csv <file>`) /memory /mcp /init /help /exit.
  - User commands come through `loadExtensions` + `expandSlashCommand`.
  - `/init` asks the agent to write AGENTS.md.
- The logo shows only before the first turn, and only when there are at least 60 columns.
- Logo assets:
  - `scripts/make-orchid.mjs` uses a pngjs devDependency and is run once. It converts `mark.png` into half-block cells with truecolor fg/bg and commits `src/theme/orchid.generated.ts`.
  - It also emits 256-color and 16-color quantized variants.
  - The ASCII fallback is hand-refined from the draft and stays symmetric.
- Tests (`apps/cli/test`, vitest + ink-testing-library):
  - Header, Composer (history, slash popup filter), Approval (destructive hides "always"), DiffCell, ExecCell, Footer and ModelPicker sort/filter.
  - App flows against MockProvider: send, stream, tool, approve, end.
  - Headless CLI: spawn `xb -p` with a fake OpenAI server, then check JSON and exit codes.
  - The root `pnpm test` already runs every package.

## Part C: Release and docs
- `release.yml` gets a `cli` job: setup-bun, then `bun build --compile` for the 3 targets, `tar.gz` per target, and upload to the same GitHub release.
- `packaging/arch/xb/PKGBUILD` defines `xari-bulbul-cli-bin` with `/usr/bin/xb`. The sha256 is filled in after the release.
- README:
  - A "Terminal" section covering install, `xb login`, keys, modes, shortcuts, headless use and the data dir.
  - The "Headless dev CLI" section gets a migration note.
  - A Project layout update.
- CLAUDE.md gets updated commands and architecture notes.
- ci.yml needs no change, since `pnpm test` and `typecheck` already cover apps/cli once it has tests.

## Execution order
1. PLAN-CLI.md
2. Codex study notes in the plan
3. Core A1–A9 with tests
4. TUI theme, logo and components
5. Host and main
6. Tests
7. Build: esbuild bundle, then a bun compile smoke test
8. README, CLAUDE.md and the release workflow
9. `pnpm typecheck && pnpm test && pnpm build`
10. Commit in logical chunks, using the no-reply email, and push to `main`
11. **Release v0.2.0:**
    - Bump `version` in the root, core, cli and desktop package.json files.
    - Tag `v0.2.0` and push the tag.
    - `gh workflow run CI --ref main`, then `gh workflow run Release --ref v0.2.0`, and watch both to green.
    - After the release, fill the sha256 into both PKGBUILDs (desktop `pkgver=0.2.0` and the new `xb` one) and push.
12. npm: the package is ready for `npm publish` but is not published.

## Verification
- `pnpm typecheck`, `pnpm test` (core plus cli) and `pnpm build` (desktop still builds).
- Drive the real TUI:
  - Run `node apps/cli/dist/xb.js` against a fake OpenAI-compatible server (`requiresKey:false`), using the tmux capture technique: `tmux new -d`, `send-keys`, `capture-pane -e`.
  - Check at 80×24 and at 120 columns.
  - Check dark, light and `NO_COLOR`.
  - Check approvals, Shift+Tab, Esc interrupt, the /model picker and diffs.
- Run one real turn with `openrouter/free` if `OPENROUTER_API_KEY` is set in the env.
- Headless: `xb -p "hi" --output-format json; echo $?`.
- Desktop: `HARNESS_DATA_DIR=/tmp/harness-dev pnpm dev`, then send a message to confirm the shared core changes didn't break it.
- Bun binary: `npx bun build --compile` locally, then run `./xb --version`.

## Decision log
- Data dir confirmed on disk: `~/Library/Application Support/Xarı Bülbül` (Electron `userData` after `app.setName`).
- Keys: the user chose one shared OS keychain store for desktop and `xb`; desktop migrates `secrets.json` on first launch.
- Release: the user chose to cut v0.2.0 with `xb` binaries. npm: package prepared, not published.
