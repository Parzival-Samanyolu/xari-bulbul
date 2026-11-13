# Model benchmark

How well do models work as the agent inside Xarı Bülbül? This suite runs real agent turns
through the app's own engine: the same system prompt, tools, permission checks and provider
adapter you get in the desktop app. It scores each run by checking the result, not by grading
the text.

The results are also on Hugging Face: [Parizival/xari-bulbul-bench](https://huggingface.co/datasets/Parizival/xari-bulbul-bench).

## Latest results

<!-- results:start -->
Run on 2026-11-13: 25 tasks, once each, on six models. The Claude models used the Anthropic API, GPT models the owner's ChatGPT plan (shown at what the same tokens would cost on OpenAI's API, without cache discounts), Gemini the free tier. Raw data: [`results/2026-11-13`](results/2026-11-13). The 2026-10-11 run with free models is in [`results/2026-10-11`](results/2026-10-11).

| Model | Pass | Coding | Tools | GitHub MCP | Speed | Hard | Median time | First token | Output tok/s | Tokens/run | Tool errors | Cost |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `anthropic:claude-sonnet-5-5` | **100%** (25/25) | 9/9 | 4/4 | 3/3 | 3/3 | 6/6 | 17.8 s | 5.62 s | 54 | 29485 | 5% | $0.9059 |
| `anthropic:claude-fable-5-2` | **100%** (25/25) | 9/9 | 4/4 | 3/3 | 3/3 | 6/6 | 18.1 s | 4.07 s | 67 | 30602 | 1% | $4.1819 |
| `anthropic:claude-opus-5-5` | **100%** (25/25) | 9/9 | 4/4 | 3/3 | 3/3 | 6/6 | 18.2 s | 3.23 s | 63 | 33931 | 15% | $1.9684 |
| `chatgpt:gpt-6-astra` | **100%** (25/25) | 9/9 | 4/4 | 3/3 | 3/3 | 6/6 | 23.9 s | 5.21 s | 17 | 29221 | 2% | ChatGPT plan (≈$7.9578 at API prices) |
| `chatgpt:gpt-6.1-terra` | **96%** (24/25) | 9/9 | 3/4 | 3/3 | 3/3 | 6/6 | 39.6 s | 5.1 s | 19 | 28029 | 3% | ChatGPT plan (≈$0.764 at API prices) |
| `google:gemini-flash-lite-latest` | **92%** (22/24) | 9/9 | 4/4 | 3/3 | 3/3 | 3/5 | 12.4 s | 1.36 s | 23 | 42273 | 11% | free tier |

| Model | Ping (one word) | Ping first token | Long answer tok/s | Long answer time | One tool call |
|---|---|---|---|---|---|
| `anthropic:claude-opus-5-5` | 2.18 s | 2.17 s | 46 | 18.9 s | 20.84 s |
| `anthropic:claude-fable-5-2` | 10.37 s | 10.37 s | 71 | 13 s | 2.51 s |
| `anthropic:claude-sonnet-5-5` | 4.13 s | 4.13 s | 71 | 12.5 s | 4.97 s |
| `chatgpt:gpt-6-astra` | 4.73 s | 4.6 s | 19 | 28.1 s | 6.59 s |
| `chatgpt:gpt-6.1-terra` | 4.75 s | 4.61 s | 39 | 12.3 s | 6.99 s |
| `google:gemini-flash-lite-latest` | 0.77 s | 0.77 s | 117 | 3.5 s | 5.33 s |

| Task | `claude-opus-5-5` | `claude-fable-5-2` | `claude-sonnet-5-5` | `gpt-6-astra` | `gpt-6.1-terra` | `gemini-flash-lite-latest` |
|---|---|---|---|---|---|---|
| Fix an off-by-one bug (`fix-off-by-one`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Implement a function from tests (`implement-slugify`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Write a parser to a spec (`parse-duration`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Rename a function across files (`rename-across-files`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Edit package.json precisely (`json-edit`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Fix the root cause of a crash (`debug-stack-trace`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Fix an async bug (`fix-async-bug`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Change one function in a long file (`large-file-edit`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Add a flag to a small CLI (`add-cli-flag`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Search the project and report a number (`count-todos`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Run a script and save its output (`run-and-capture`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Trace a config value through files (`find-config-value`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Start, read and stop a background process (`background-job`) | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| Look up a repo on GitHub (`gh-repo-facts`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Find code in a GitHub repo (`gh-find-file`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Read a file from GitHub (`gh-read-file`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Speed: one-word reply (`speed-ping`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Speed: long answer, no tools (`speed-long-output`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Speed: one tool call (`speed-tool-roundtrip`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| RFC 4180 CSV parser with hidden edge cases (`hard-csv-parse`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| npm-style semver ranges, prereleases included (`hard-semver-range`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| Wrong invoice caused by state two modules away (`hard-debug-pricing`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Stale search results from an event bus bug (`hard-debug-search`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Convert a five-module project from callbacks to promises (`hard-callbacks-to-async`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| Change a function signature at every call site (`hard-change-signature`) | ✓ | ✓ | ✓ | ✓ | ✓ |  |

Notes:
- **Gemini:** the first run hit free-tier quota errors (429) on every task, so its results come from a rerun one task at a time. `hard-callbacks-to-async` still failed with a 429, and `hard-change-signature` hit one on every try, so Gemini has 24 runs. Its other failure (`hard-semver-range`) hit the 30-step limit.
- **`gh-repo-facts`:** it used to ask for the "latest" release, which changes with every release. It now asks about a fixed one (v0.2.6), and its results are from a rerun after that change.
- **gpt-6.1-terra:** stopped the background server in `background-job` but didn't report its token.
- **API prices** for the GPT models: gpt-6-astra $10 / $50, gpt-6.1-terra $1 / $5 per million input / output tokens (list prices, 2026-11).
<!-- results:end -->

## Tasks

| Task | Category | Passes when |
|---|---|---|
| `fix-off-by-one` | coding | the failing `node test.js` passes, and `test.js` is unchanged |
| `implement-slugify` | coding | a stub passes 5 tests, including Turkish and accented letters |
| `parse-duration` | coding | a parser written from a prose spec passes hidden tests, including error cases |
| `rename-across-files` | coding | `getUsr` is renamed in 3 files (one in a subfolder) and the tests pass |
| `json-edit` | coding | `package.json` has the minor bump, the new script and the removed dependency, and nothing else changed |
| `debug-stack-trace` | coding | a crash is fixed at its cause (a misspelled config key), not with a guard where it throws |
| `fix-async-bug` | coding | `forEach(async …)` is fixed so results arrive complete and in order |
| `large-file-edit` | coding | one function near line 450 of a 700-line file changes, and no other line does |
| `add-cli-flag` | coding | a `--json` flag works before or after the file name, and the table output is unchanged |
| `count-todos` | tools | the reply has the exact number of `TODO`s in `src/**/*.js` (with decoys outside it) |
| `run-and-capture` | tools | `out.txt` holds exactly what a script prints |
| `find-config-value` | tools | the production port, traced through a config loader, a JSON override and an env file (with decoys) |
| `background-job` | tools | a long-running process is started, its token reported, and the process is gone when the turn ends |
| `gh-repo-facts` | github-mcp | the publish date of a fixed release and the repo's license, looked up with the GitHub tools |
| `gh-find-file` | github-mcp | the path of the file that defines a class, found with GitHub code search |
| `gh-read-file` | github-mcp | a value read from a file in a repo on GitHub |
| `speed-ping` | speed | the reply is just `pong`, with no tools |
| `speed-long-output` | speed | a 400-word answer with no tools (at least 250 words) |
| `speed-tool-roundtrip` | speed | one `read_file`, then the file's contents as the reply |
| `hard-csv-parse` | hard | an RFC 4180 parser passes 21 hidden cases: quoted line breaks, `""`, CRLF, blank rows, and errors after a closing quote |
| `hard-semver-range` | hard | npm-style `satisfies()` with `^`/`~`/x-ranges/hyphens and npm's prerelease rule passes 46 hidden cases |
| `hard-debug-pricing` | hard | a wrong invoice is fixed where the shared defaults get mutated, two modules from the symptom (with a rounding decoy), and the defaults stay untouched |
| `hard-debug-search` | hard | stale search results are fixed in the event bus (`off()` removed the wrong listener), not by guarding the widget that unmounts twice |
| `hard-callbacks-to-async` | hard | five callback modules become promise-only, keep `NOT_FOUND` handling and order, and pass a hidden suite |
| `hard-change-signature` | hard | `formatMoney(amount, currency)` becomes `formatMoney({ amount, currency, locale })` at every caller, including an alias, `.apply` and a re-bound import |

The speed tasks take one or two requests each, so their timings aren't mixed with tool time or
long agent loops. The report gives them their own table: one-word reply time and first token,
output tokens per second on the long answer, and the time for one tool call.

GitHub answers only count if a GitHub MCP tool call succeeded, so a model can't pass by guessing.

The hard tasks keep fixtures small so runs stay cheap. Each one is graded by a hidden test the
model never sees, so code that only fits the visible `test.js`, or a patch on the failing path
instead of at the cause, fails. Run them alone with `--category hard`.

## How runs work

- Each run starts in a new empty temp folder with the task's files, in **auto** mode, with a 30-step limit and a 7-minute timeout.
- Memory, web search, web fetch and subagents are off, so runs don't depend on each other or on the network.
- The GitHub MCP tools come from GitHub's hosted server (`api.githubcopilot.com/mcp/`). Only tools the server marks read-only are included, and only the GitHub tasks get them.
- A model's runs go one at a time, because free tiers rate-limit per key. Different models run side by side. `--parallel` starts every run at once (for paid keys).
- Spending stops at $5 per bench run by default (`--max-usd 20` raises it, `--max-usd 0` turns it off). Runs in flight are stopped when the cap is reached.
- Provider errors (rate limits, request too large) count as failures. They are what you'd hit using that model.

Columns in the results table:
- **Median time:** wall-clock seconds per finished run.
- **First token:** time until the first streamed token.
- **Output tok/s:** completion tokens divided by the time spent waiting on the model (tool time excluded).
- **Tokens/run:** prompt plus completion tokens per finished run.
- **Tool errors:** the share of tool calls that returned an error.

## Run it yourself

```bash
pnpm install
pnpm bench                                     # your favorite models (Settings → Models), every task once
pnpm bench -- --reps 3 --models openrouter:openrouter/free,google:gemini-3.5-flash-lite
pnpm bench -- --tasks gh-find-file,json-edit --out bench/results/try
pnpm --filter @harness/bench report bench/results/try   # writes summary.json and summary.md
```

The benchmark uses your settings, keys and MCP servers. For the GitHub tasks, add GitHub in
**Settings → MCP Servers** and save a token. `HARNESS_DATA_DIR` selects another profile.

Each results folder holds `runs.jsonl` (one line per run), `summary.json` and `summary.md`.
