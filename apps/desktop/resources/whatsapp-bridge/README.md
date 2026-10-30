# Xarı Bülbül WhatsApp bridge

A small separate program that links Xarı Bülbül to your WhatsApp account as a linked device,
the way WhatsApp Web does. The app starts it with `node bridge.mjs` while WhatsApp is turned on
in Settings › Gateways › WhatsApp, and talks to it over stdin/stdout, one JSON object per line.

**WhatsApp support downloads the open-source Baileys library (MIT) and its libsignal dependency (GPL-3.0) to your computer when you turn it on.** Neither is part of the Xarı Bülbül app or its
installers. When you turn WhatsApp on, the app copies this folder to `<data folder>/whatsapp-bridge/`
and runs `npm install --omit=dev --no-audit --no-fund` there, so you need Node.js 20 or newer.

This folder's own code (`bridge.mjs`) is MIT-licensed, like the rest of Xarı Bülbül. Its design
follows the WhatsApp bridge of Hermes Agent (MIT, Copyright (c) 2025 Nous Research).

WhatsApp doesn't offer this officially. Use it at your own risk: WhatsApp may restrict accounts
that automate messages.

## Protocol

App → bridge (stdin):

| Command | Fields | Does |
|---|---|---|
| `send` | `id`, `to`, `text` | Sends a text; answers with `result` and the message ids |
| `typing` | `to`, `on` | Shows or clears "typing…" |
| `pair` | `id`, `phone` | Asks for a pairing code instead of the QR code |
| `logout` | `id` | Unlinks this device and exits |
| `stop` | | Closes the connection and exits |

Bridge → app (stdout): `ready`, `qr` (`qr`, `svg`), `pairing_code` (`code`), `connected` (`me`),
`disconnected` (`reason`, `retryInMs`), `qr_timeout`, `logged_out`, `replaced`, `message`
(`id`, `chat`, `chatAlt`, `fromMe`, `text`, `at`), `result` (`id`, `ok`, `messageIds` or `error`),
`log` (`level`, `msg`). Anything else Baileys prints goes to stderr.

Only messages you send yourself (`fromMe`) outside groups, broadcasts and channels leave this
process, and the app further accepts only those in your own "Message yourself" chat.
