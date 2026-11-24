# xari: Xarı in the terminal

The desktop app's agent, in a terminal. It runs the same engine (`@harness/core`) with the same tools,
MCP servers, memory, skills and permission modes, and it uses the **same data folder**, so a chat
started here shows up in the desktop app and the other way round.

## Install from source

Needs Node 22 or newer and pnpm.

```bash
pnpm install
pnpm build:cli                      # writes apps/cli/dist/xari.mjs (one bundled file)
node apps/cli/dist/xari.mjs --help

# or link the command:
cd apps/cli && npm link             # then: xari --help
# or run from source without building:
pnpm cli -- -p "hello"
```

## Usage

```bash
xari                                 # interactive chat in the current folder
xari "fix the failing test"          # interactive, with a first message
xari -p "explain this repo"          # one turn, print the answer, exit
cat error.log | xari -p "what broke?"        # stdin and prompt are combined
git diff | xari -p "review" --mode plan
xari -p "list TODOs" --output-format json    # one JSON result object
xari -p "refactor utils" --output-format stream-json   # one JSON event per line, then the result
xari -c                              # continue the latest chat in this folder
xari -r <id>                         # resume a chat by id (or the start of it)
xari --model groq/openai/gpt-oss-120b
xari --cwd ~/code/app --mode auto -p "run the tests and fix failures"
```

| Flag | Meaning |
|---|---|
| `-p`, `--print <prompt>` | Non-interactive: run one turn and exit. The prompt may also come from stdin. |
| `--output-format text\|json\|stream-json` | Output of `-p` (default `text`). |
| `--model <id>` | `provider/model`, `provider:model` or a model id (favorites and recents first, then the default provider). |
| `--mode ask\|acceptEdits\|plan\|auto` | Permission mode for this run. Default: the one in settings. |
| `-c`, `--continue` | Continue the latest chat in the folder. |
| `-r`, `--resume <id>` | Resume a chat by id. |
| `--cwd <dir>` | Work in another folder. |
| `--max-steps <n>` | Most model steps in one turn. |
| `-v`, `--version`, `-h`, `--help` | |

Non-interactive runs cannot ask for approval, so anything that would ask is denied and reported.
Use `--mode auto` (or allow rules in settings) for runs that must edit files or run commands. Destructive
commands still ask, so they are denied in `-p`.

Exit codes: `0` done, `1` error, `2` usage, `3` budget, `4` step limit, `130` interrupted (Ctrl+C).

## The interactive chat

Run `xari` in a project folder. What's finished scrolls up like normal terminal output, so your
terminal's own scrolling, search and copy work; only the bottom is live: the reply being written,
running tools, approvals and the prompt.

| Key | Does |
|---|---|
| `enter` | send (while it works, your message waits in a queue) |
| `alt+enter`, `ctrl+j` | new line in the prompt; pasted text keeps its line breaks |
| `esc` | stop the agent; twice clears the prompt |
| `shift+tab` | cycle Ask → Auto-edit → Plan → Full auto |
| `↑` `↓` | earlier prompts (saved in the data folder) |
| `tab` | complete a `/` command |
| `ctrl+c` | stop, then clear, then (twice) quit · `ctrl+d` quits on an empty prompt |
| `ctrl+l` | clear the screen |

Approvals show the command or the change. Answer with `1`/`y` (yes), `2`/`a` (yes for the rest of
the chat) or `3`/`n`, or just type what it should do instead and press Enter.

Commands: `/help`, `/new`, `/resume`, `/model [provider/model]`, `/mode [mode]`, `/compact`,
`/undo` (put back the files the last turn changed), `/cost`, `/exit`, plus your own commands and skills.
Colours follow `NO_COLOR`. The theme picks light or dark from your terminal (`COLORFGBG`); set
`XARI_THEME=light` or `XARI_THEME=dark` to choose.

The UI is built with [Ink](https://github.com/vadimdemedes/ink). Markdown, syntax-highlighted code,
diffs and the option lists use components from [Gemini CLI](https://github.com/google-gemini/gemini-cli)
(Apache 2.0, see `src/ui/vendor/gemini/` and `THIRD_PARTY_NOTICES.md`); the layout, the prompt and
the wiring to Xarı's engine are Xarı's own (`src/ui/App.tsx`, `src/ui/store.ts`).

## Where things live

The data folder is the desktop app's: `~/Library/Application Support/Xarı Bülbül` (macOS),
`%APPDATA%\Xarı Bülbül` (Windows), `~/.config/Xarı Bülbül` (Linux). Set `HARNESS_DATA_DIR` to use another one.
It holds `settings.json`, `sessions/`, `memory/` and `usage.jsonl`. Settings are only read, never written.

Extensions (`~/.harness`, `<project>/.harness`), skills and installed plugins load as in the desktop app.
Project tool code runs only if "load project extensions" is on in settings. MCP servers from settings
connect in the background and are closed on exit.

## API keys

1. `<PROVIDER>_API_KEY` environment variables (`OPENROUTER_API_KEY`, `GROQ_API_KEY`, `OLLAMA_CLOUD_API_KEY`, …) always win.
2. Then the OS keychain the desktop app uses: macOS Keychain, or libsecret (`secret-tool`) on Linux.
3. A `xb-secrets.json` file in the data folder, if there is no keychain.

**Limitation:** on Linux without a keyring and on Windows, the desktop app stores keys with Electron's
safeStorage, which only Electron can decrypt. The CLI prints a hint when it finds no key for the model's
provider: set the env var, or install libsecret and a keyring and enter the key again in the desktop app.
"Continue with ChatGPT" works when the sign-in is in the keychain; while the desktop app is open the CLI
only borrows its access token (it lasts about an hour).

Not in the terminal yet: mail, notes, automations, gateways, local model management and the browser's saved logins.

## Development

```bash
pnpm --filter @harness/cli test        # args, host and a full -p turn against a mock server
pnpm --filter @harness/cli typecheck
```

`src/host.ts` builds the engine pieces (`createHost`), `src/args.ts` parses the command line,
`src/main.ts` has `run(argv, io)` (what the tests call), and `src/tui/index.ts` starts the interactive mode (the Ink app in `src/ui/`):
`runInteractive(host, { initialPrompt, session })`.
