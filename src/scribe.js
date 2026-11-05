// The proposal pipeline, independent of dsh: summary in, proposal on disk out.

import { draftSkill, NAME_RE } from "./draft.js"
import { gate, parseSkillResult } from "./gate.js"
import { redact, redactDeep } from "./redact.js"
import { quotaLeft, writeProposal } from "./store.js"

/**
 * Find the existing skill (if any) that this turn loaded via the `skill` tool.
 * @param {object} summary
 * @param {(name:string)=>Promise<{path?:string, content?:string}|undefined>} [skillsGet] optional registry lookup
 */
export async function resolveExisting(summary, skillsGet) {
  const used = summary.usedSkills ?? []
  for (const r of summary.skillResults ?? []) {
    if (r.isError) continue
    const { name } = parseSkillResult(r.text)
    if (!NAME_RE.test(name ?? "") || (used.length && !used.includes(name))) continue
    if (skillsGet) {
      try {
        const s = await skillsGet(name)
        if (typeof s?.content === "string" && s.content.trim()) return { name, path: s.path, content: s.content }
      } catch {
        /* fall through to the next skill */
      }
    }
  }
  if (used.length || summary.skillResults?.some((r) => !r.isError)) throw new Error("used skill could not be resolved from registry")
  return undefined
}

/**
 * Run the full pipeline for one finished turn.
 * @returns {Promise<{status:"proposed", id:string, kind:string, drafter:string} | {status:"skipped", reason:string} | {status:"error", error:string}>}
 */
export async function processTurn({ home, config, summary, llm, skillsGet, now = new Date() }) {
  const g = gate(summary, config)
  if (!g.ok) return { status: "skipped", reason: g.reason }
  if (quotaLeft(home, config.maxProposalsPerDay, now) <= 0) return { status: "skipped", reason: "daily-limit" }
  try {
    const existing = await resolveExisting(summary, skillsGet)
    const result = await draftSkill(llm, summary, { language: config.language, existing })
    if (result.kind === "skip") return { status: "skipped", reason: `model: ${result.reason}` }
    if (quotaLeft(home, config.maxProposalsPerDay, now) <= 0) return { status: "skipped", reason: "daily-limit" }
    const written = writeProposal(
      home,
      result.skill,
      redactDeep({
        sessionId: summary.sessionId,
        turn: summary.turn,
        taskSummary: summary.task.replace(/\s+/g, " ").trim(),
        toolCallCount: summary.toolCallCount,
        drafter: result.drafter,
        ...(result.errors.length ? { draftErrors: result.errors } : {}),
        kind: existing ? "update" : "new",
        ...(existing ? { target: existing.name, ...(existing.path ? { targetPath: existing.path } : {}) } : {}),
      }),
      now,
      config.maxProposalsPerDay,
    )
    return { status: "proposed", id: written.id, kind: written.meta.kind, drafter: result.drafter }
  } catch (e) {
    if (e.code === "SCRIBE_DAILY_LIMIT") return { status: "skipped", reason: "daily-limit" }
    return { status: "error", error: redact(String(e?.message ?? e)) }
  }
}
