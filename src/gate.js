// Turn collection and gating. Pure: takes session events, returns summaries.

import { redact } from "./redact.js"


const MAX_TASK = 2000
const MAX_ARG = 1500
const MAX_RESULT = 1200
const MAX_CALLS = 60

function textOf(content) {
  if (!Array.isArray(content)) return ""
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
}

function clip(s, n) {
  return s.length > n ? `${s.slice(0, n)}...[truncated ${s.length - n} chars]` : s
}

/**
 * Collects the events of each session's current turn.
 * `feed(sessionId, event)` returns a turn summary when a turn ends, else undefined.
 */
export class TurnCollector {
  constructor() {
    this.state = new Map()
  }

  forget(sessionId) {
    this.state.delete(sessionId)
  }

  feed(sessionId, event) {
    const d = event.data ?? {}
    switch (event.type) {
      case "turn/start":
        this.state.set(sessionId, fresh(d.turn))
        return undefined
      case "user/message": {
        const s = this.state.get(sessionId)
        if (!s) return undefined
        const src = d.source?.kind
        if (src === "user" && s.task === undefined) s.task = textOf(d.content)
        if (src === "skill-invocation" && typeof d.source.name === "string") s.usedSkills.add(d.source.name)
        return undefined
      }
      case "tool/call": {
        const s = this.state.get(sessionId)
        if (!s) return undefined
        s.calls.push({ callId: d.callId, name: String(d.name), arguments: String(d.arguments ?? ""), result: "", isError: false, done: false })
        if (d.name === "skill") {
          const n = parseSkillName(d.arguments)
          if (n) s.usedSkills.add(n)
        }
        return undefined
      }
      case "tool/result": {
        const s = this.state.get(sessionId)
        if (!s) return undefined
        const m = d.message ?? {}
        const call = s.calls.find((c) => c.callId === m.toolCallId)
        if (call) {
          call.result = textOf(m.content)
          call.isError = m.isError === true
          call.done = true
          if (call.name === "skill") s.skillResults.push({ callId: call.callId, text: call.result, isError: call.isError })
        }
        return undefined
      }
      case "assistant/message": {
        const s = this.state.get(sessionId)
        if (!s) return undefined
        const t = textOf(d.message?.content)
        if (t) s.finalText = t
        return undefined
      }
      case "turn/end": {
        const s = this.state.get(sessionId)
        this.state.delete(sessionId)
        if (!s) return undefined
        return summarize(sessionId, d, s)
      }
      default:
        return undefined
    }
  }
}

function fresh(turn) {
  return { turn, task: undefined, calls: [], usedSkills: new Set(), skillResults: [], finalText: "" }
}

function parseSkillName(args) {
  try {
    const v = JSON.parse(args)
    return typeof v?.name === "string" ? v.name : undefined
  } catch {
    return undefined
  }
}

/** Extract the skill name and directory out of the `skill` tool result text. */
export function parseSkillResult(text) {
  const name = /<skill_content name="([^"]+)"/.exec(text)?.[1]
  const dir = /Base directory for this skill:\s*(.+)/.exec(text)?.[1]?.trim()
  return { name, dir }
}

function summarize(sessionId, endData, s) {
  const reasonKind = endData.reason?.kind
  const work = s.calls.filter((c) => c.name !== "skill")
  const last = [...work].reverse().find((c) => c.done)
  return {
    sessionId,
    turn: endData.turn ?? s.turn,
    reason: reasonKind,
    task: clip(redact(s.task ?? ""), MAX_TASK),
    toolCallCount: work.length,
    endedWithError: reasonKind !== "completed" || last?.isError === true,
    errorCalls: work.filter((c) => c.isError).length,
    usedSkills: [...s.usedSkills],
    skillResults: s.skillResults,
    finalText: clip(redact(s.finalText), MAX_TASK),
    calls: work.slice(0, MAX_CALLS).map((c) => ({
      name: c.name,
      arguments: clip(redact(c.arguments), MAX_ARG),
      result: clip(redact(c.result), MAX_RESULT),
      isError: c.isError,
    })),
  }
}

/**
 * Decide whether a finished turn is worth a proposal.
 * @returns {{ok: boolean, reason?: string}}
 */
export function gate(summary, config) {
  if (!summary) return { ok: false, reason: "no-summary" }
  if (summary.reason !== "completed") return { ok: false, reason: `turn-${summary.reason}` }
  if (summary.endedWithError) return { ok: false, reason: "ended-with-error" }
  if (!summary.task) return { ok: false, reason: "no-task" }
  if (summary.toolCallCount < config.minToolCalls) return { ok: false, reason: "too-few-tool-calls" }
  return { ok: true }
}
