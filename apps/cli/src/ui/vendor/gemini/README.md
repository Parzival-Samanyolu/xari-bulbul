# Code from Gemini CLI

These files come from [Gemini CLI](https://github.com/google-gemini/gemini-cli) by Google LLC,
under the Apache License 2.0 (`LICENSE` in this folder). Copied from commit `03862c4`
(0.73.0-nightly, 23 November 2026), `packages/cli/src/ui/`.

| File | From | Changes |
|---|---|---|
| `MarkdownDisplay.tsx` | `utils/MarkdownDisplay.tsx` | imports only |
| `InlineMarkdownRenderer.tsx` | `utils/InlineMarkdownRenderer.tsx` | none |
| `markdownParsingUtils.ts` | `utils/markdownParsingUtils.ts` | imports only |
| `latexToUnicode.ts` | `utils/latexToUnicode.ts` | none |
| `CodeColorizer.tsx` | `utils/CodeColorizer.tsx` | imports only |
| `textUtils.ts` | `utils/textUtils.ts` | imports; dropped two hooks into Gemini's fork of Ink |
| `DiffRenderer.tsx` | `components/messages/DiffRenderer.tsx` | imports only |
| `RadioButtonSelect.tsx` | `components/shared/RadioButtonSelect.tsx` | imports only |
| `BaseSelectionList.tsx` | `components/shared/BaseSelectionList.tsx` | imports only |
| `color-utils.ts` | `themes/color-utils.ts` | none |
| `theme.ts` | `themes/theme.ts` | imports; custom-theme loading removed |
| `semantic-tokens.ts` | `themes/semantic-tokens.ts` | none |
| `default-dark.ts` | `themes/builtin/dark/default-dark.ts` | made a function of the colour palette |
| `TableRenderer.tsx` | `utils/TableRenderer.tsx` | rewritten: same props, plain Ink (the original needs Gemini's Ink fork) |
| `MaxSizedBox.tsx` | `components/shared/MaxSizedBox.tsx` | rewritten: same props, counts rows instead of measuring; its note is translated |

`_shim.ts` is Xarı's own: the theme in Xarı's colours, the few settings these components read, a
selection hook on Ink's `useInput`, small helpers that replace Gemini CLI internals, and `useT` for
Xarı's interface language. Only text Xarı wrote is translated; Gemini CLI's own strings stay English.

Each file keeps Google's copyright and license header and says how it was changed. Everything
else under `apps/cli/src/ui` is Xarı's code (MIT).
