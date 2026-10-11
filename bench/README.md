# Model benchmark

How well do models work as the agent inside Xarı Bülbül? This suite runs real agent turns
through the app's own engine: the same system prompt, tools, permission checks and provider
adapter you get in the desktop app. It scores each run by checking the result, not by grading
the text.

The results are also on Hugging Face: [Parizival/xari-bulbul-bench](https://huggingface.co/datasets/Parizival/xari-bulbul-bench).

## Latest results

<!-- results:start -->
Run on 2026-10-11 with the owner's four favorite models, all on free tiers. Raw data: [`results/2026-10-11`](results/2026-10-11).

| Model | Pass | Coding | Tools | GitHub MCP | Median time | First token | Output tok/s | Tokens/run | Tool errors | Cost |
|---|---|---|---|---|---|---|---|---|---|---|
| `openrouter:nvidia/nemotron-3.5-lightning` | **82%** (9/11) | 4/6 | 2/2 | 3/3 | 25.8 s | 0.92 s | 30 | 34625 | 0% | $0 |
| `google:gemini-flash-lite-latest` | **80%** (16/20) | 7/10 | 4/4 | 5/6 | 4.4 s | 0.96 s | 45 | 22852 | 4% | free tier |
| `ollama-cloud:gpt-oss:120b` | **80%** (16/20) | 9/10 | 2/4 | 5/6 | 4.6 s | 0.45 s | 122 | 34065 | 23% | free tier |
| `groq:openai/gpt-oss-120b` | **27%** (3/11) | 2/6 | 1/2 | 0/3 | 108.3 s | 18.6 s | 4 | 16408 | 0% | free tier |

| Task | `google` | `ollama-cloud` | `openrouter` | `groq` |
|---|---|---|---|---|
| Fix an off-by-one bug (`fix-off-by-one`) | ✓ ✗ | ✓ ✓ | ✓ ✓ | ✓ ✓ |
| Implement a function from tests (`implement-slugify`) | ✓ ✓ | ✓ ✓ | ✓ | ✗ |
| Write a parser to a spec (`parse-duration`) | ✓ ✓ | ✓ ✓ | ✗ | ✗ |
| Rename a function across files (`rename-across-files`) | ✓ ✗ | ✗ ✓ | ✗ | ✗ |
| Edit package.json precisely (`json-edit`) | ✗ ✓ | ✓ ✓ | ✓ | ✗ |
| Search the project and report a number (`count-todos`) | ✓ ✓ | ✗ ✓ | ✓ | ✗ |
| Run a script and save its output (`run-and-capture`) | ✓ ✓ | ✓ ✗ | ✓ | ✓ |
| Look up a repo on GitHub (`gh-repo-facts`) | ✓ ✓ | ✓ ✓ | ✓ | ✗ |
| Find code in a GitHub repo (`gh-find-file`) | ✓ ✗ | ✓ ✗ | ✓ | ✗ |
| Read a file from GitHub (`gh-read-file`) | ✓ ✓ | ✓ ✓ | ✓ | ✗ |

Notes:
- **Partial runs:** Gemini and Ollama ran every task twice (20 runs each). Nemotron and Groq were slowed by free-tier rate limits, and the run was stopped after they had finished 11 tasks each, most only once. Their percentages come from fewer runs.
- **Groq:** its free tier allows 8,000 tokens per minute. With the GitHub MCP tools, each request is about 8,800 tokens, so every GitHub task fails with "413 Request too large". Groq also failed some runs with "Parsing failed" errors from its side.
- **Gemini:** 3 failures are free-tier quota errors (429), not wrong answers.
- **Rescoring:** one `count-todos` answer ("There are 5 TODO comments. 5") was rescored after the checker was fixed to accept it.
- **Since this run:** tools now clamp out-of-range numbers instead of rejecting the call. gpt-oss sent `bash` `timeout_sec: 10000` (it read it as milliseconds) and `grep` `max_results: 10000`, which caused most of its tool errors. A rerun of 6 tasks × 3 with the fix: Ollama tool errors 22% → 9%, passes 14/18 → 16/18.
<!-- results:end -->

## Tasks

| Task | Category | Passes when |
|---|---|---|
| `fix-off-by-one` | coding | the failing `node test.js` passes, and `test.js` is unchanged |
| `implement-slugify` | coding | a stub passes 5 tests, including Turkish and accented letters |
| `parse-duration` | coding | a parser written from a prose spec passes hidden tests, including error cases |
| `rename-across-files` | coding | `getUsr` is renamed in 3 files (one in a subfolder) and the tests pass |
| `json-edit` | coding | `package.json` has the minor bump, the new script and the removed dependency, and nothing else changed |
| `count-todos` | tools | the reply has the exact number of `TODO`s in `src/**/*.js` (with decoys outside it) |
| `run-and-capture` | tools | `out.txt` holds exactly what a script prints |
| `gh-repo-facts` | github-mcp | the latest release tag and license of a repo, looked up with the GitHub tools |
| `gh-find-file` | github-mcp | the path of the file that defines a class, found with GitHub code search |
| `gh-read-file` | github-mcp | a value read from a file in a repo on GitHub |

GitHub answers only count if a GitHub MCP tool call succeeded, so a model can't pass by guessing.

## How runs work

- Each run starts in a new empty temp folder with the task's files, in **auto** mode, with a 30-step limit and a 7-minute timeout.
- Memory, web search, web fetch and subagents are off, so runs don't depend on each other or on the network.
- The GitHub MCP tools come from GitHub's hosted server (`api.githubcopilot.com/mcp/`). Only tools the server marks read-only are included, and only the GitHub tasks get them.
- A model's runs go one at a time, because free tiers rate-limit per key. Different models run side by side.
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
