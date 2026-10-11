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
