// dsh-skill-scribe: turns finished agent turns into SKILL.md *proposals*.
// It never activates anything: proposals sit in $DSH_HOME/skill-scribe/proposed/
// until a human runs `scribe accept` (CLI) or `/scribe accept` (in dsh).

import { appendFileSync } from "node:fs"
import { execute, splitArgs } from "./src/cli.js"
import { resolveConfig, resolveHome } from "./src/config.js"
import { TurnCollector } from "./src/gate.js"
import { makeLlm } from "./src/llm.js"
import { processTurn } from "./src/scribe.js"
import { redact } from "./src/redact.js"

export const name = "dsh-skill-scribe"
export const inject = ["sessions", "llm", "skills"]

// Config schema (cordis). schemastery is a peer dependency of dsh itself; if it
// cannot be resolved the plugin still loads and validates config by hand.
let z
try {
  z = (await import("@deepseek-ai/schemastery")).default
} catch {
  z = undefined
}

export const Config = z
  ? z.object({
      enabled: z.boolean().default(true).description("Master switch."),
      minToolCalls: z.number().step(1).min(1).default(3).description("A turn needs at least this many tool calls (skill loads excluded)."),
      model: z
        .object({ provider: z.string(), model: z.string() })
        .description("LLM route for drafting. Omit to use the session's own route."),
      endpoint: z
        .object({ baseURL: z.string(), model: z.string(), apiKeyEnv: z.string() })
        .description("OpenAI-compatible endpoint used when the dsh model layer is unavailable."),
      language: z.string().default("auto").description('Language of the draft; "auto" follows the task.'),
      maxProposalsPerDay: z.number().step(1).min(0).default(10).description("Daily cap on new proposals."),
      timeoutMs: z.number().step(1000).min(1000).default(180000).description("Per-call LLM timeout."),
      maxOutputTokens: z.number().step(1).min(256).default(4096).description("Output-token cap for the drafting call."),
      shutdownGraceMs: z.number().step(100).min(0).max(4500).default(3000).description("Max delay an in-flight draft may add to process shutdown before it is aborted."),
      home: z.string().description("Override $DSH_HOME (testing)."),
    })
  : undefined

export function apply(ctx, rawConfig = {}) {
  return install(ctx, rawConfig, { makeLlm })
}

/** Wiring, exported separately so tests can inject a stub LLM factory. */
export function install(ctx, rawConfig, deps) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return
  const home = resolveHome(config)
  const collector = new TurnCollector()
  const inflight = new Set() // promises, for orderly shutdown
  const busy = new Set() // session ids with a draft in progress (max 1 each)
  const shutdown = new AbortController()

  const log = (level, msg) => {
    msg = redact(msg)
    if (process.env.SKILL_SCRIBE_DEBUG) {
      try {
        appendFileSync(process.env.SKILL_SCRIBE_DEBUG, `${new Date().toISOString()} ${level} ${msg}\n`)
      } catch {
        /* ignore */
      }
    }
    try {
      ctx.logger[level](`skill-scribe: ${msg}`)
    } catch {
      /* logger unavailable */
    }
  }

  async function handleSummary(session, summary) {
    const skillsGet = async (n) => {
      const s = await ctx.skills.get(n, { cwd: session.header?.cwd })
      return s ? { path: s.path, content: s.content } : undefined
    }
    let llm
    try {
      llm = deps.makeLlm(ctx, session, config, shutdown.signal)
    } catch (e) {
      log("warn", `no LLM available (${e?.message ?? e}); skipping draft`)
      const err = e
      llm = () => Promise.reject(err)
    }
    const res = await processTurn({ home, config, summary, llm, skillsGet })
    if (res.status === "proposed") log("info", `proposal ${res.id} (${res.kind}, ${res.drafter}) written; review with: scribe show ${res.id}`)
    else if (res.status === "error") log("warn", `failed: ${res.error}`)
    else log("info", `no proposal (${res.reason})`)
  }

  ctx.on("session/event", (session, event) => {
    if (!event?.type) return
    if ((session.header?.delegationDepth ?? 0) > 0) return // sub-agents are not proposal sources
    let summary
    try {
      summary = collector.feed(session.id, event)
    } catch (e) {
      log("warn", `collector error: ${e?.message ?? e}`)
      return
    }
    if (!summary) return
    // Cheap pre-gate so we only claim the per-session slot for promising turns.
    if (summary.reason !== "completed" || summary.endedWithError || summary.toolCallCount < config.minToolCalls) return
    if (busy.has(session.id)) return
    busy.add(session.id)
    log("debug", `turn ${summary.turn} ended with ${summary.toolCallCount} tool calls; drafting`)
    const p = handleSummary(session, summary)
      .catch((e) => log("warn", `unexpected: ${e?.message ?? e}`))
      .finally(() => {
        busy.delete(session.id)
        inflight.delete(p)
      })
    inflight.add(p)
  })

  ctx.on("session/disposed", (session) => {
    collector.forget(session.id)
  })

  // dsh gives the whole app ~5 s to dispose after a one-shot run, and the model
  // adapters go away during that window. Give an in-flight draft a short grace
  // period; if it is still running, abort it and skip the unfinished draft.
  ctx.effect(() => async () => {
    log("debug", `shutdown: ${inflight.size} draft(s) in flight`)
    const settled = () => Promise.allSettled([...inflight])
    const within = async (ms) => {
      let timer
      const sleep = new Promise((r) => (timer = setTimeout(r, ms)))
      await Promise.race([settled(), sleep])
      clearTimeout(timer)
    }
    await within(config.shutdownGraceMs)
    if (inflight.size > 0) {
      log("debug", "shutdown: grace elapsed, aborting in-flight draft(s)")
      shutdown.abort(new Error("interrupted by dsh shutdown"))
      await within(1000)
    }
  }, "skill-scribe: drain drafts")

  ctx.inject(["commands"], (cc) => {
    cc.effect(
      () =>
        cc.commands.register({
          name: "scribe",
          description: "Review skill proposals: list | show | diff | accept | reject",
          input: { hint: "list|show <id>|diff <id>|accept <id>|reject <id>" },
          handler: ({ rawInput }) => {
            const { code, text } = execute(splitArgs(rawInput), { home })
            return { kind: code === 0 ? "success" : "error", text }
          },
        }),
      "skill-scribe: /scribe command",
    )
  })
}
