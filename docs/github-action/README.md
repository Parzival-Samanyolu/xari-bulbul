# Xarı GitHub Action

Runs the `xari` CLI (the same agent as the desktop app) on a prompt inside a workflow. Use it to review pull
requests, explain failures, or make small fixes and open a PR.

The action is a composite action at `.github/actions/xari`. It checks out nothing itself: your workflow checks
out your code, and the action builds the CLI from **its own** checkout (the ref in `uses:`), so the CLI version
always matches the ref you pin.

```yaml
- uses: Parzival-Samanyolu/xari-bulbul/.github/actions/xari@main
  with:
    api-key: ${{ secrets.OPENROUTER_API_KEY }}
    prompt: Summarize what this repository does in five lines.
```

## What it does

1. Sets up pnpm and Node 22 (the pnpm store is cached by `actions/setup-node`, keyed on `pnpm-lock.yaml`).
2. Builds the CLI: `pnpm install --frozen-lockfile --filter "@harness/cli..."` then `pnpm build:cli`. The filter
   installs only the CLI and the workspace packages it needs, not the desktop app. Building from source (rather
   than downloading a release) keeps the action self-contained and pinned to one ref; the cost is about a minute
   on a cold cache.
3. Writes a minimal `settings.json` into a temp `HARNESS_DATA_DIR` (model, and a custom provider if asked; memory
   off), so the run never touches a real data folder.
4. Runs `xari -p` in `working-directory` with your prompt on stdin (a large diff cannot hit the argument limit),
   the chosen `--mode`, `--output-format` and `--max-steps`. The key is passed as `<PROVIDER>_API_KEY`
   (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CUSTOM_API_KEY`).
5. Sets the outputs, and with `comment-on-pr: 'true'` posts the answer on the pull request. The comment carries a
   hidden marker (`<!-- xari-action -->`), so later runs edit it instead of adding another.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `prompt` | required | What to ask. Put any context (diff, log) in the text. |
| `api-key` | required | Provider key. Pass a secret. It is masked and never printed. |
| `provider` | `openrouter` | `openrouter`, `anthropic`, `openai` or `custom`. |
| `model` | `openrouter/free` | Model id as the provider names it, without a provider prefix. The default is OpenRouter's free router, fine for trying it out; pick a stronger model for real work, e.g. `anthropic/claude-sonnet-4.5` (OpenRouter) or `claude-sonnet-4-5` (Anthropic). |
| `mode` | `plan` | `plan` read-only, `acceptEdits` may edit files, `auto` may also run commands. |
| `base-url` | | OpenAI-compatible API root. Required (and only used) when `provider` is `custom`. |
| `max-steps` | CLI default | Most model steps in one turn. Set it to bound cost. |
| `working-directory` | `.` | Folder the agent works in, relative to the workspace. |
| `comment-on-pr` | `false` | `true` posts or updates a PR comment with the answer. Needs `pull-requests: write`. |
| `github-token` | `github.token` | Used only for the comment. It is not given to the agent. |
| `output-format` | `text` | What the CLI prints: `text`, `json` or `stream-json`. The `result` output is always the final text. |

## Outputs

| Output | Meaning |
|---|---|
| `result` | The agent's final answer. |
| `exit-code` | `0` done, `1` error, `3` budget, `4` step limit. The step also fails the job when it is not `0`. |

## Examples

Both live in this folder (not under `.github/workflows`, so they never run in this repository). Copy one into your
own `.github/workflows/`.

- [`review.example.yml`](review.example.yml): reviews each PR's diff (`git diff origin/<base>...HEAD`, passed in the
  prompt) in `plan` mode and keeps one comment up to date.
- [`fix-tests.example.yml`](fix-tests.example.yml): `workflow_dispatch` that asks the agent to fix failing tests in
  `acceptEdits` mode, then opens a PR with [peter-evans/create-pull-request](https://github.com/peter-evans/create-pull-request).

Using the answer in a later step:

```yaml
- id: xari
  uses: Parzival-Samanyolu/xari-bulbul/.github/actions/xari@main
  with: { api-key: "${{ secrets.OPENROUTER_API_KEY }}", prompt: "List risky TODOs" }
- run: echo "$RESULT"
  env:
    RESULT: ${{ steps.xari.outputs.result }}
```

(Pass the output through `env:`, not by pasting `${{ }}` into a script, so its text cannot become shell code.)

## Security

- **`plan` (default) cannot edit files or run commands.** Anything that would need approval is denied, because a CI
  run cannot ask.
- **`acceptEdits`** lets the agent change files in the workspace. Review the diff before merging.
- **`auto` lets the agent run commands on the runner**, as the job's user, with the job's network. Treat the prompt
  and every file it reads as untrusted input: a malicious file or PR can try to steer the agent. Use `auto` only in
  repositories and jobs where that is acceptable, with minimal `permissions:`.
- **Do not run it on `pull_request_target` against code from forks while secrets are available.** That event runs
  with your secrets, and a fork's checked-out code or diff could carry prompt injection that exfiltrates them (or,
  in `auto`, runs commands). Use plain `pull_request` (forks get no secrets, so skip them as the review example
  does), or require a maintainer to label or approve before the job runs.
- The API key is masked with `::add-mask::` and handed only to the CLI process. The agent process does not receive
  `GITHUB_TOKEN` or other workflow secrets, but its answer can still be shown in comments and logs, so do not put
  secrets in prompts.
- Give the workflow the least `permissions:` it needs. Pin the action to a tag or commit SHA.

## Costs

Every run is billed by your model provider; the action adds nothing. A review sends the diff plus whatever files the
agent reads, and steps multiply that, so for `auto`/`acceptEdits` set `max-steps`, and cap what you pass in (the review
example trims the diff to 120 KB). The free default model is rate limited and weaker; use a paid model for reviews you
rely on. GitHub-hosted runner minutes also count, mostly the build step (cached after the first run).

## Not tested here

The action was exercised locally only: `run.mjs` against a mock OpenAI-compatible server and a mock GitHub API. The
`action.yml` steps (pnpm and Node setup, cache, build) have not run on a real GitHub runner.
