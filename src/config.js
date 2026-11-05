import { homedir } from "node:os"
import { join } from "node:path"

export const DEFAULTS = Object.freeze({
  enabled: true,
  minToolCalls: 3,
  model: undefined, // { provider, model }; omitted -> same route as the session
  endpoint: undefined, // { baseURL, model, apiKeyEnv } OpenAI-compatible fallback
  language: "auto",
  maxProposalsPerDay: 10,
  timeoutMs: 180000,
  maxOutputTokens: 4096,
  shutdownGraceMs: 3000, // how long an in-flight draft may delay process shutdown
  home: undefined, // override of $DSH_HOME (mainly for tests)
})

/** Merge user config over defaults and coerce obviously wrong values. */
export function resolveConfig(input = {}) {
  const c = { ...DEFAULTS, ...stripUndefined(input) }
  c.enabled = c.enabled !== false
  c.minToolCalls = intInRange(c.minToolCalls, 1, Infinity, DEFAULTS.minToolCalls)
  c.maxProposalsPerDay = intInRange(c.maxProposalsPerDay, 0, Infinity, DEFAULTS.maxProposalsPerDay)
  c.timeoutMs = intInRange(c.timeoutMs, 1000, Infinity, DEFAULTS.timeoutMs, 1000)
  c.maxOutputTokens = intInRange(c.maxOutputTokens, 256, Infinity, DEFAULTS.maxOutputTokens)
  c.shutdownGraceMs = intInRange(c.shutdownGraceMs, 0, 4500, DEFAULTS.shutdownGraceMs, 100)
  c.language = typeof c.language === "string" && c.language ? c.language : "auto"
  if (c.model && !(c.model.provider && c.model.model)) c.model = undefined
  if (c.endpoint && !(c.endpoint.baseURL && c.endpoint.model)) c.endpoint = undefined
  return Object.freeze(c)
}

function stripUndefined(o) {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined && v !== null))
}

function intInRange(v, min, max, fallback, step = 1) {
  return Number.isInteger(v) && v >= min && v <= max && (v - min) % step === 0 ? v : fallback
}

/** `$DSH_HOME` (env or override), else `~/.dsh`. */
export function resolveHome(config = {}, env = process.env) {
  const raw = config.home ?? env.DSH_HOME
  if (raw) return raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw
  return join(homedir(), ".dsh")
}
