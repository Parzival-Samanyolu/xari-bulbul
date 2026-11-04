// Secret redaction for the local app log. Unlike share info's scrubText, paths and names stay
// (the log never leaves the computer unless the user exports it), but anything that looks like
// a key, token or password is replaced before it is written.

const RULES: [RegExp, string][] = [
  // JSON Web Tokens
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[redacted]'],
  // Provider key prefixes: OpenAI/Anthropic/OpenRouter sk-…, GitHub, Slack, Google, Hugging Face, Groq, xAI
  [/\b(sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|xox[abprs]|AIza|hf|gsk|xai|nvapi)([-_])[A-Za-z0-9_-]{8,}/g, '$1$2[redacted]'],
  // Authorization header values
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  // key=value and "key": "value" forms
  [/\b((?:api[_-]?key|apikey|x-api-key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)[^\s"',;&}]{4,}/gi, '$1[redacted]'],
  // Query-string credentials
  [/([?&](?:key|api_key|apikey|token|access_token|auth|sig|signature)=)[^&\s"']+/gi, '$1[redacted]'],
  // Long opaque strings mixing letters and digits (most other API keys and tokens)
  // (not inside paths, URLs or file names: those start after a / or .)
  [/(?<![\w/.-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}(?![\w.])/g, '[redacted]'],
]

/** Replaces anything that looks like a key, token or password in `text`. */
export function redactSecrets(text: string): string {
  let t = String(text ?? '')
  for (const [re, by] of RULES) t = t.replace(re, by)
  return t
}
