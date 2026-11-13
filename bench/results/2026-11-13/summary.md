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
