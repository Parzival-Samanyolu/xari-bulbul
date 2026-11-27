# Demo GIFs

| File | Shows |
| --- | --- |
| `xari-cli.gif` | The terminal CLI (`xari`) in ask mode: a prompt is typed, the model reads `src/orders.js`, proposes an edit, the approval box appears and is answered with `1`, the diff is applied. |
| `xari-desktop.gif` | The Xarı desktop app: a prompt typed into the composer, the reply streaming, the `read_file` and `edit_file` tool cards with the diff. |

## How they were made

Every demo talks to `scripts/mock-model.cjs`, a tiny scripted OpenAI-compatible server (SSE streaming, a reasoning delta, a tool call). No real model, no network, no keys.

- **CLI:** run inside `tmux` (100x32), typed with `tmux send-keys`, the pane captured with `tmux capture-pane -p -e` about ten times a second, each distinct screen rendered to PNG with xterm.js in headless Chromium (Playwright).
- **Desktop:** the built Electron app driven by Playwright under `xvfb`, with a throwaway `HARNESS_DATA_DIR`, `HOME` and project folder in `/tmp`. Screenshots are taken in a loop (~9 fps) while text is typed and the reply streams.
- **GIF assembly:** `scripts/lib.cjs` feeds the frames with their real timings to `ffmpeg` (`palettegen` + `paletteuse`, 64–128 colours, 960–1000 px wide).

## Regenerate

Needs `tmux`, `xvfb`, `ffmpeg`, and Playwright with Chromium (`npm i -g playwright && npx playwright install chromium`). From the repo root, after `pnpm install`:

```sh
export NODE_PATH=$(npm root -g)        # where playwright lives
# the Electron binary is found in node_modules; otherwise set ELECTRON_BIN=/path/to/electron

pnpm build:cli
node docs/media/scripts/record-cli.cjs                      # -> docs/media/xari-cli.gif

pnpm --filter @harness/desktop build
xvfb-run -a node docs/media/scripts/record-desktop.cjs xari     # -> docs/media/xari-desktop.gif
xvfb-run -a node docs/media/scripts/record-desktop.cjs bots     # -> docs/media/xari-bots.gif (optional)
```

Each script fails if the demo did not do what it should (for example the edit did not land), so a broken recording is not written silently. Fixed ports 47811 (CLI), 47812 (desktop) and 47822 (desktop, bots demo) are used for the mock model.
