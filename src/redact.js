// Secret redaction. Applied to every text that is sent to an LLM and to every
// text that is written to disk. Conservative on purpose: false positives only
// cost a few characters in a draft, false negatives leak a credential.

export const REDACTED = "[REDACTED]"

// Token formats that are recognisable on their own.
const TOKEN_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9_]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // A webhook URL is itself the credential.
  /\bhttps?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
  /\bhttps?:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g,
]

// Standalone Bearer values may occur outside a header.
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi
// A missing closing quote consumes the rest of the input so a malformed secret cannot leak a suffix.
const QUOTED_VALUE = String.raw`"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'(?:\\[\s\S]|[^'\\])*(?:'|\\?$)`
const COMMAND_VALUE = `${QUOTED_VALUE}|[^\\s;]+`
const FIELD_VALUE = `${QUOTED_VALUE}|[^\\s"',;]+`
const HEADER = new RegExp(String.raw`(\b(?:proxy-authorization|authorization|set-cookie|cookie)(?:"|')?\s*:\s*)(${QUOTED_VALUE}|[^\r\n,}]+)`, "gi")
const CLI_SECRET = new RegExp(String.raw`((?:^|\s)(?:--(?:user|cookie|[a-z0-9_-]*(?:password|passphrase|secret|token|api[-_]key|access[-_]key))(?:\s+|=)|-u\s+))(${COMMAND_VALUE})`, "gi")
const MYSQL_COMMAND = new RegExp(String.raw`\bmysql\b(?:${QUOTED_VALUE}|[^"'\r\n;])*`, "gi")
const MYSQL_PASSWORD = new RegExp(String.raw`(\s-p)(${COMMAND_VALUE})`, "g")
const SSHPASS_PASSWORD = new RegExp(String.raw`(\bsshpass\b[ \t]+-p[ \t]*)(${COMMAND_VALUE})`, "gi")

// Signed URLs carry the credential in a query parameter.
const QUERY_SECRET = /([?&](?:X-Amz-Signature|X-Goog-Signature|signature|sig)=)[^&\s"'#]+/gi
// "My API key is abc123...": a digit is required so "the token is valid" stays readable.
const PROSE_SECRET = /(\b(?:api[ _-]?key|password|passphrase|secret|token)\s+(?:is|was)\s+["'`]?)(?=[^\s"'`]*\d)[A-Za-z0-9_.\/+=-]{8,}/gi
const PROSE_SECRET_JA = /((?:パスワード|パスフレーズ|API\s?キー|アクセスキー|トークン|シークレット)\s*(?:は|[:：=])\s*["'`「]?)[!-~]{6,}/g

// `-b` means something else in most tools, so it is a cookie only for curl.
const CURL_COMMAND = new RegExp(String.raw`\bcurl\b(?:${QUOTED_VALUE}|[^"'\r\n;])*`, "gi")
const CURL_COOKIE = new RegExp(String.raw`(\s-b\s*)(${COMMAND_VALUE})`, "g")
// `session` is often an ordinary value, so only long opaque ones are masked.
const QUERY_SESSION = /([?&](?:session(?:[_-]?id)?|sid)=)[A-Za-z0-9_.~%-]{16,}/gi

function maskValue(_match, head, value) {
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : ""
  return `${head}${quote}${REDACTED}${quote}`
}

// NAME=value / NAME: value / "name": "value" where NAME looks like a secret.
// The key may be prefixed (OPENAI_API_KEY) or suffixed (token_2).
const SECRET_NAME = "[A-Za-z0-9_.-]*(?:api[_-]?key|apikey|access[_-]?key|secret|token|passwd|password|passphrase|pwd|sshpass|credential|private[_-]?key|(?<![A-Za-z])(?:auth(?:orization)?|pass)(?![A-Za-z]))[A-Za-z0-9_.-]*"
const ENV_SECRET_NAME = new RegExp(`^${SECRET_NAME}$`, "i")
const ASSIGNMENT = new RegExp(
  `(["']?\\b${SECRET_NAME}\\b["']?\\s*[=:]\\s*)(${FIELD_VALUE})`,
  "gi",
)
// export FOO_TOKEN=... style is covered by ASSIGNMENT; URL userinfo is separate.
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi

/**
 * Replace secret-looking substrings with a fixed marker.
 * @param {unknown} text
 * @returns {string}
 */
export function redact(text) {
  if (typeof text !== "string" || text.length === 0) return typeof text === "string" ? text : ""
  let out = text
  const values = [...new Set(Object.entries(process.env)
    .filter(([name, value]) => name !== "PWD" && name !== "OLDPWD" && ENV_SECRET_NAME.test(name) && value?.length >= 8)
    .map(([, value]) => value))].sort((a, b) => b.length - a.length)
  if (values.length) {
    const literals = new RegExp(values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
    out = out.replace(literals, REDACTED)
  }
  for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED)
  out = out.replace(HEADER, maskValue)
  out = out.replace(CLI_SECRET, maskValue)
  out = out.replace(CURL_COMMAND, (command) => command.replace(CURL_COOKIE, maskValue))
  out = out.replace(MYSQL_COMMAND, (command) => command.replace(MYSQL_PASSWORD, maskValue))
  out = out.replace(SSHPASS_PASSWORD, maskValue)
  out = out.replace(BEARER, `$1${REDACTED}`)
  out = out.replace(URL_USERINFO, `$1${REDACTED}$2`)
  out = out.replace(QUERY_SECRET, `$1${REDACTED}`)
  out = out.replace(QUERY_SESSION, `$1${REDACTED}`)
  out = out.replace(PROSE_SECRET, `$1${REDACTED}`)
  out = out.replace(PROSE_SECRET_JA, `$1${REDACTED}`)
  out = out.replace(ASSIGNMENT, (match, head, value, offset, source) => {
    const name = /^["']?([A-Za-z0-9_.-]+)/.exec(head)?.[1]
    if (name === "PWD" || name === "OLDPWD") return match
    const scalar = /^(\d+|true|false)([}\]]*)$/.exec(value)
    if ((name === "max_tokens" || name === "tokens") && scalar && /^\d{1,6}$/.test(scalar[1])) return match
    if (name === "pass" && scalar && /^(?:true|false)$/.test(scalar[1])) return match
    if (name === "pwd" && value === "process.cwd()" && /(?:^|[;\n])\s*const\s+$/.test(source.slice(0, offset))) return match
    if (scalar && head.startsWith('"')) return `${head}"${REDACTED}"${scalar[2]}`
    return maskValue(match, head, value)
  })
  return out
}

/** Recursively redact every string inside a JSON-like value. */
export function redactDeep(value) {
  if (typeof value === "string") return redact(value)
  if (Array.isArray(value)) return value.map(redactDeep)
  if (value && typeof value === "object") {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v)
    return out
  }
  return value
}
