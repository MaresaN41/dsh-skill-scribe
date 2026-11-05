import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export function tmpHome(t) {
  const dir = mkdtempSync(join(tmpdir(), "scribe-test-"))
  t?.after?.(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

let seq = 0
const ev = (type, data) => ({ type, seq: seq++, time: Date.now(), data })

export const turnStart = (turn = 1) => ev("turn/start", { turn })
export const turnEnd = (turn = 1, kind = "completed") => ev("turn/end", { turn, reason: { kind } })
export const userMsg = (text, source = { kind: "user" }) =>
  ev("user/message", { content: [{ type: "text", text }], source, role: "user", id: `u${seq}` })
export const asstMsg = (text) => ev("assistant/message", { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text }] } })
export const toolCall = (callId, name, args = {}) =>
  ev("tool/call", { turn: 1, step: 1, callId, name, arguments: typeof args === "string" ? args : JSON.stringify(args) })
export const toolResult = (callId, text, isError = false) =>
  ev("tool/result", {
    turn: 1,
    step: 1,
    message: { role: "tool", toolCallId: callId, content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) },
  })

/** A complete successful turn with n non-skill tool calls. */
export function turnEvents({ task = "Aggregate sales.csv per region and write summary.txt", calls = 3, extra = [], endKind = "completed", lastError = false } = {}) {
  const out = [turnStart(), userMsg(task), ...extra]
  for (let i = 0; i < calls; i++) {
    out.push(toolCall(`c${i}`, i % 2 ? "bash" : "read", i % 2 ? { command: `echo step${i}` } : { file_path: `/w/f${i}.txt` }))
    out.push(toolResult(`c${i}`, `result ${i}`, lastError && i === calls - 1))
  }
  out.push(asstMsg("All done."), turnEnd(1, endKind))
  return out
}

export const GOOD_DRAFT = [
  "---",
  "name: aggregate-csv-by-region",
  "description: Aggregate a CSV by a key column and write a summary file",
  "whenToUse: When asked to total a CSV column per group",
  "---",
  "",
  "# Aggregate a CSV by region",
  "",
  "## Steps",
  "1. Read the CSV header.",
  "2. Aggregate with awk.",
  "3. Write and verify the output.",
  "",
  "## Notes",
  "- Check the delimiter first.",
].join("\n")
