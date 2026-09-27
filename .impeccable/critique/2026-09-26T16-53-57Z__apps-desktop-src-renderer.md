---
target: apps/desktop
total_score: 25
p0_count: 0
p1_count: 3
timestamp: 2026-09-26T16-53-57Z
slug: apps-desktop-src-renderer
---
Method: dual-agent (A: design review sub-agent · B: detector + browser sub-agent)

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Status bar shows tokens/requests/cost/context live; tool duration includes approval wait; context meter is tiny |
| 2 | Match System / Real World | 3 | Raw tool ids and model-facing tool descriptions shown to users; "In / M" headers cryptic |
| 3 | User Control and Freedom | 2 | No undo for applied edits; failed send leaves orphaned prompt; workspace menu has no Esc |
| 4 | Consistency and Standards | 2 | Mode as pill vs cards; two Deny buttons; "Settings → Providers" vs "Providers & Keys"; emoji + text glyph icons |
| 5 | Error Prevention | 2 | Keyless providers always fail; Full auto has no friction; keyless models selectable |
| 6 | Recognition Rather Than Recall | 3 | Good kbd hints and slash menu; ⌘A always-allow undiscoverable, session scope only in tooltip |
| 7 | Flexibility and Efficiency | 3 | ⌘K/⌘N/⌘,/Shift+Tab/history/slash; no keyboard chat switching |
| 8 | Aesthetic and Minimalist Design | 3 | Calm chat; picker repeats "free" 5x/row; hero-metric cards in Usage |
| 9 | Error Recovery | 2 | "No API key" notice not actionable; picker empty result has no message |
| 10 | Help and Documentation | 2 | Good empty-chat tips + extension example; no docs link, dense rule syntax paragraph |
| **Total** | | **25/40** | **Acceptable** |

## Anti-Patterns Verdict
Mostly clean: restrained plum, no gradients/glass/stripes. Tells: hero-metric triad in Usage & Budgets (Settings.tsx usage-cards); emoji tool icons (Chat.tsx TOOL_ICON); uppercase tracked group labels in picker. Detector CLI: 0 findings. In-browser detector (injected via CDP): tiny-text (10.9-11.9px model ids, tool descriptions, hints), line-length (~127ch settings descriptions), flat-type-hierarchy (11-13 sizes 9.3-14px), plus false positives (overused-font Inter — renders SF; cramped-padding on segmented control; all-caps on group label; thin-border-wide-shadow on palette). Detector low-contrast rule cannot parse oklch → silent; manual CDP contrast measurements used instead.

## Priority Issues
- [P1] Keyless/local providers blocked end to end (App gates on hasAnyKey; openai-compat throws without key; UI advertises local Ollama/LM Studio; send posts prompt then fails). Fix: "no key needed" per provider, gate on usable provider, validate before posting, actionable error. Command: harden
- [P1] Keyboard & screen-reader gaps: .session divs unreachable, hover-only delete, permission dialog lacks role=dialog/aria-modal/focus trap, picker rows no listbox semantics, toggles/inputs unnamed, range slider no focus style, no live region for streaming. Command: audit / harden
- [P1] Non-text contrast < 3:1: --border 1.22-1.45:1 used for toggle-off tracks, input borders, idle star (1.22-1.35:1). Fix: --control-border ≥3:1; idle star uses --muted. Command: colorize
- [P2] Permission prompt: 4 actions incl. two denies, hidden ⌘A, session scope in tooltip, modal hides context. Fix: 3 actions + inline reason field; consider inline approval. Command: clarify / distill
- [P2] Model switcher: filters hide current model; no empty state; "free" repeated; tiny 10.9px ids. Fix: pin current+recent, empty state with clear filters, single price column. Command: clarify / distill

## Persona Red Flags
Alex: no keyboard chat switching; menus lack Esc; filters hide current model; ⌘A collides with select-all.
Sam: dialog not announced + focus leaks; silent picker; unnamed toggles; emoji read aloud; sub-3:1 boundaries; no live region.
GitHub tinkerer: ~/.harness path vs Xarı Bülbül brand; can't add keyless local Ollama; no in-app tool/command authoring; custom provider can't be tested before save.

## Minor Observations
Welcome primary button on the completed step; three-column settings layout; Test button wraps inconsistently; web_fetch/todo_write badged read-only; tool duration counts approval wait; remove links far from rules; workspace menu overflows sidebar; native confirm() for deletes; 19px mode/status targets; truncated descriptions without title; double space in composer placeholder.

## Questions to Consider
- What would a quiet "turn receipt" (files changed · cost · revert) look like at the end of each turn?
- Should permission live inline in the stream instead of a modal?
- What would make extending the tool feel like part of the product, like Obsidian's plugin pane?
