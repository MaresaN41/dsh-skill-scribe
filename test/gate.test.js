import assert from "node:assert/strict"
import { test } from "node:test"
import { TurnCollector, gate, parseSkillResult } from "../src/gate.js"
import { resolveConfig } from "../src/config.js"
import { asstMsg, toolCall, toolResult, turnEnd, turnEvents, turnStart, userMsg } from "./helpers.js"

const cfg = resolveConfig({})

function run(events, sid = "s1") {
  const c = new TurnCollector()
  let summary
  for (const e of events) summary = c.feed(sid, e) ?? summary
  return summary
}

test("collects task, calls, results and final text", () => {
  const s = run(turnEvents({ calls: 3 }))
  assert.equal(s.toolCallCount, 3)
  assert.equal(s.task, "Aggregate sales.csv per region and write summary.txt")
  assert.equal(s.calls[0].result, "result 0")
  assert.equal(s.finalText, "All done.")
  assert.equal(s.reason, "completed")
  assert.equal(s.endedWithError, false)
})

test("gate passes at the default threshold of 3", () => {
  assert.deepEqual(gate(run(turnEvents({ calls: 3 })), cfg), { ok: true })
})

test("gate rejects fewer calls than minToolCalls", () => {
  assert.equal(gate(run(turnEvents({ calls: 2 })), cfg).reason, "too-few-tool-calls")
  assert.equal(gate(run(turnEvents({ calls: 4 })), resolveConfig({ minToolCalls: 5 })).reason, "too-few-tool-calls")
  assert.equal(gate(run(turnEvents({ calls: 4 })), resolveConfig({ minToolCalls: 4 })).ok, true)
})

test("gate rejects non-completed turns", () => {
  for (const kind of ["aborted", "error", "blocked", "max-tokens"]) {
    assert.equal(gate(run(turnEvents({ endKind: kind })), cfg).ok, false, kind)
  }
})

test("gate rejects a turn whose last tool call failed", () => {
  const s = run(turnEvents({ calls: 3, lastError: true }))
  assert.equal(s.endedWithError, true)
  assert.equal(gate(s, cfg).reason, "ended-with-error")
})

test("an early failure that was recovered from does not block", () => {
  const ev = [
    turnStart(), userMsg("task"),
    toolCall("a", "bash", { command: "bad" }), toolResult("a", "boom", true),
    toolCall("b", "bash", { command: "good" }), toolResult("b", "ok"),
    toolCall("c", "read", { file_path: "/x" }), toolResult("c", "ok"),
    asstMsg("done"), turnEnd(),
  ]
  const s = run(ev)
  assert.equal(s.errorCalls, 1)
  assert.equal(gate(s, cfg).ok, true)
})

test("skill loader calls are not counted as work and mark used skills", () => {
  const ev = [
    turnStart(), userMsg("task"),
    toolCall("s", "skill", { name: "csv-report" }),
    toolResult("s", '<skill_content name="csv-report">\n<skill_resources>\nBase directory for this skill: /h/skills/csv-report\n</skill_resources>'),
    toolCall("a", "bash", { command: "x" }), toolResult("a", "ok"),
    toolCall("b", "bash", { command: "y" }), toolResult("b", "ok"),
    asstMsg("done"), turnEnd(),
  ]
  const s = run(ev)
  assert.equal(s.toolCallCount, 2)
  assert.deepEqual(s.usedSkills, ["csv-report"])
  assert.equal(gate(s, cfg).reason, "too-few-tool-calls")
  assert.deepEqual(parseSkillResult(s.skillResults[0].text), { name: "csv-report", dir: "/h/skills/csv-report" })
})

test("only a human user message becomes the task", () => {
  const ev = [turnStart(), userMsg("<system-reminder>ctx</system-reminder>", { kind: "runtime-context" }), userMsg("real task"), turnEnd()]
  assert.equal(run(ev).task, "real task")
})

test("turns of different sessions do not mix", () => {
  const c = new TurnCollector()
  c.feed("a", turnStart())
  c.feed("b", turnStart())
  c.feed("a", userMsg("task a"))
  c.feed("b", userMsg("task b"))
  assert.equal(c.feed("a", turnEnd()).task, "task a")
  assert.equal(c.feed("b", turnEnd()).task, "task b")
})

test("redacts synthetic secrets before clipping summary text", () => {
  const key = "SCRIBE_TEST_API_TOKEN"
  const previous = process.env[key]
  const secret = "synthetic-secret-value-that-crosses-the-clip-boundary"
  process.env[key] = secret
  try {
    const taskPrefix = "t".repeat(1963)
    const argsPrefix = "a".repeat(1463)
    const resultPrefix = "r".repeat(1163)
    const finalPrefix = "f".repeat(1963)
    const events = [
      turnStart(),
      userMsg(taskPrefix + secret),
      toolCall("x", "bash", argsPrefix + secret),
      toolResult("x", resultPrefix + secret),
      asstMsg(finalPrefix + secret),
      turnEnd(),
    ]

    const summary = run(events)
    assert.equal(summary.task, taskPrefix + "[REDACTED]")
    assert.equal(summary.finalText, finalPrefix + "[REDACTED]")
    assert.equal(summary.calls[0].arguments, argsPrefix + "[REDACTED]")
    assert.equal(summary.calls[0].result, resultPrefix + "[REDACTED]")
    assert.equal(JSON.stringify(summary).includes(secret), false)
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
})

test("events outside a turn are ignored", () => {
  const c = new TurnCollector()
  assert.equal(c.feed("s", toolCall("x", "bash")), undefined)
  assert.equal(c.feed("s", turnEnd()), undefined)
})
