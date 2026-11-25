// Pure helpers for the Xarı GitHub Action. No I/O here, so the tests can cover them directly.

/** Hidden marker that lets the action find and update its own PR comment instead of adding a new one. */
export const MARKER = '<!-- xari-action -->'

/** Providers with a built-in entry in Xarı's settings; anything else needs a base URL. */
export const KNOWN_PROVIDERS = { openrouter: 'OpenRouter', anthropic: 'Anthropic', openai: 'OpenAI' }

/** `openrouter` -> `OPENROUTER_API_KEY` (same rule as packages/core/src/host/paths.ts). */
export function envKeyName(providerId) {
  return `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
}

/**
 * The minimal settings.json for a CI run: the model to use, and for `custom` an OpenAI-compatible
 * provider at `baseUrl`. Memory is off so a run leaves nothing behind. Everything else is defaulted by
 * Xarı's own schema when it reads the file.
 */
export function buildSettings({ provider, model, baseUrl = '' }) {
  if (!model) throw new Error('model is required')
  if (provider !== 'custom' && !KNOWN_PROVIDERS[provider]) {
    throw new Error(`provider must be one of: ${Object.keys(KNOWN_PROVIDERS).join(', ')}, custom (got "${provider}")`)
  }
  const settings = {
    models: { default: { providerId: provider, modelId: model } },
    memory: { enabled: false },
    mcp: { servers: [] },
  }
  if (provider === 'custom') {
    if (!/^https?:\/\//.test(baseUrl ?? '')) throw new Error('base-url (http:// or https://) is required when provider is "custom"')
    settings.providers = [{ id: 'custom', name: 'Custom', baseUrl: baseUrl.replace(/\/+$/, ''), requiresKey: true }]
  }
  return settings
}

/** Command-line arguments for `xari`; the prompt itself goes through stdin so a big diff never hits the argv limit. */
export function buildArgs({ mode, outputFormat, maxSteps }) {
  const args = ['--output-format', outputFormat, '--mode', mode]
  if (maxSteps) args.push('--max-steps', String(maxSteps))
  // `-p` last with no value: the prompt is read from stdin.
  args.push('-p')
  return args
}

/** The final answer from xari's stdout, whatever the output format. */
export function extractResult(stdout, outputFormat) {
  const text = stdout.trim()
  if (outputFormat === 'text') return text
  const lines = outputFormat === 'json' ? [text] : text.split('\n').reverse()
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj && typeof obj.result === 'string') return obj.result
    } catch {
      // not a JSON line; keep looking
    }
  }
  return text
}

/** The PR comment: the answer, a footer, and the hidden marker. Capped well under GitHub's 65536-character limit. */
export function commentBody(result, { model, mode } = {}) {
  const max = 60000
  let text = result.trim() || '_Xarı finished without an answer._'
  if (text.length > max) text = `${text.slice(0, max)}\n\n_(answer truncated)_`
  const footer = [model && `\`${model}\``, mode && `mode \`${mode}\``].filter(Boolean).join(' · ')
  return `${MARKER}\n${text}\n\n---\n<sub>Xarı${footer ? ` · ${footer}` : ''}</sub>\n`
}

/** A `GITHUB_OUTPUT` entry that survives multi-line values; the delimiter can't occur in `value`. */
export function outputEntry(name, value, delimiter = `XARI_EOF_${Math.random().toString(36).slice(2)}`) {
  while (value.includes(delimiter)) delimiter += '_'
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`
}
