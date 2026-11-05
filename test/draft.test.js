import assert from "node:assert/strict"
import { test } from "node:test"
import { buildPrompt, draftSkill, parseDraft, parseFrontmatter, renderSkill } from "../src/draft.js"
import { REDACTED } from "../src/redact.js"
import { GOOD_DRAFT } from "./helpers.js"

const summary = {
  sessionId: "session-1",
  turn: 1,
  task: "Aggregate sales.csv per region, key sk-abcdefghijklmnopqrstuvwxyz123456",
  finalText: "done",
  calls: [
    { name: "read", arguments: '{"file_path":"/w/sales.csv"}', result: "region,units", isError: false },
    { name: "bash", arguments: '{"command":"awk -F, \'{t[$1]+=$2} END{for(r in t) print r,t[r]}\' sales.csv"}', result: "north 3", isError: false },
    { name: "write", arguments: '{"file_path":"/w/summary.txt"}', result: "ok", isError: false },
  ],
}

test("parseDraft accepts a valid SKILL.md", () => {
  const r = parseDraft(GOOD_DRAFT)
  assert.equal(r.kind, "skill")
  assert.equal(r.skill.name, "aggregate-csv-by-region")
  assert.match(r.skill.body, /## Steps/)
})

test("parseDraft tolerates code fences and <think> blocks", () => {
  const r = parseDraft(`<think>hmm</think>\n\`\`\`markdown\n${GOOD_DRAFT}\n\`\`\``)
  assert.equal(r.kind, "skill")
})

test("parseDraft recognises SKIP", () => {
  assert.deepEqual(parseDraft("SKIP: one-off task"), { kind: "skip", reason: "one-off task" })
})

test("parseDraft rejects bad names, missing front matter, empty body, long description", () => {
  assert.equal(parseDraft(GOOD_DRAFT.replace("aggregate-csv-by-region", "Bad Name")).kind, "invalid")
  assert.equal(parseDraft("just text").kind, "invalid")
  assert.equal(parseDraft("").kind, "invalid")
  assert.equal(parseDraft("---\nname: ok-name\ndescription: d\n---\n\nx").kind, "invalid")
  assert.equal(parseDraft(GOOD_DRAFT.replace("Aggregate a CSV by a key column and write a summary file", "x".repeat(500))).kind, "invalid")
})

test("parseDraft defaults whenToUse to description and enforces expectName", () => {
  const noWhen = GOOD_DRAFT.replace(/^whenToUse:.*\n/m, "")
  assert.equal(parseDraft(noWhen).skill.whenToUse, parseDraft(noWhen).skill.description)
  assert.equal(parseDraft(GOOD_DRAFT, { expectName: "other-name" }).kind, "invalid")
  assert.equal(parseDraft(GOOD_DRAFT, { expectName: "aggregate-csv-by-region" }).kind, "skill")
})

test("renderSkill output re-parses to the same fields and is valid YAML-ish", () => {
  const { skill } = parseDraft(GOOD_DRAFT)
  const text = renderSkill(skill)
  const fm = parseFrontmatter(text)
  assert.equal(fm.data.name, skill.name)
  assert.equal(fm.data.description, skill.description)
  assert.equal(fm.data.whenToUse, skill.whenToUse)
})

test("renderSkill quotes values that contain colons or quotes", () => {
  const text = renderSkill({ name: "x-y", description: 'Use: when "quoted" #hash', whenToUse: "a: b", body: "# T\n\n1. step one is here" })
  assert.equal(parseFrontmatter(text).data.description, 'Use: when "quoted" #hash')
})

test("renderSkill redacts raw fields before YAML quoting", () => {
  const text = renderSkill({
    name: "safe-skill",
    description: 'Use "report" with password: "hunter2" and token: "abcd"',
    whenToUse: 'When passphrase: "tiny" is provided\nwith "normal" quotes',
    body: '## Steps\n1. Run sshpass -p hunter2, then keep "report".\n2. Note token: "abcd".',
  })
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text)
  assert.ok(front)
  const data = parseFrontmatter(text).data
  for (const field of ["description", "whenToUse"]) {
    const quoted = new RegExp(`^${field}: (".*")$`, "m").exec(front[1])
    assert.ok(quoted)
    assert.equal(JSON.parse(quoted[1]), data[field])
  }
  assert.equal(data.name, "safe-skill")
  assert.match(data.description, /Use "report"/)
  assert.match(data.whenToUse, /with "normal" quotes/)
  assert.match(text, /keep "report"/)
  for (const secret of ["hunter2", "abcd", "tiny"]) assert.ok(!text.includes(secret), text)
})

test("renderSkill rejects an unsafe name", () => {
  assert.throws(() => renderSkill({ name: "bad: name", description: "safe", whenToUse: "safe", body: "## Steps\n1. Safe." }), /name/)
})

test("buildPrompt redacts secrets and asks for the strict format", () => {
  const { system, user } = buildPrompt(summary, {})
  assert.ok(!user.includes("sk-abcdefghijklmnopqrstuvwxyz123456"))
  assert.ok(user.includes(REDACTED))
  assert.match(system, /SKIP:/)
  assert.match(system, /whenToUse/)
})

test("buildPrompt honours the language setting and update mode", () => {
  assert.match(buildPrompt(summary, { language: "ja" }).system, /in ja\./)
  const u = buildPrompt(summary, { existing: { name: "csv-report", content: "OLD BODY" } })
  assert.match(u.system, /same name/)
  assert.match(u.user, /OLD BODY/)
})

test("draftSkill: valid first answer, one LLM call", async () => {
  let calls = 0
  const r = await draftSkill(async () => (calls++, GOOD_DRAFT), summary, {})
  assert.equal(r.kind, "skill")
  assert.equal(r.drafter, "llm")
  assert.equal(calls, 1)
})

test("draftSkill: invalid first answer triggers exactly one retry with feedback", async () => {
  const seen = []
  const r = await draftSkill(async (_s, u) => (seen.push(u), seen.length === 1 ? "garbage" : GOOD_DRAFT), summary, {})
  assert.equal(r.drafter, "llm")
  assert.equal(r.attempts, 2)
  assert.equal(seen.length, 2)
  assert.match(seen[1], /previous answer was rejected/)
})

test("draftSkill: two invalid answers skip without inventing a draft", async () => {
  let calls = 0
  const r = await draftSkill(async () => (calls++, "nope"), summary, {})
  assert.equal(calls, 2)
  assert.equal(r.kind, "skip")
  assert.match(r.reason, /draft failed:.*missing --- front matter/)
  assert.equal(r.skill, undefined)
})

test("draftSkill: a transport error skips without retrying", async () => {
  let calls = 0
  const r = await draftSkill(async () => { calls++; throw new Error("ECONNREFUSED") }, summary, {})
  assert.equal(calls, 1)
  assert.equal(r.kind, "skip")
  assert.match(r.reason, /ECONNREFUSED/)
  assert.equal(r.skill, undefined)
})

test("draftSkill: SKIP is honoured", async () => {
  const r = await draftSkill(async () => "SKIP: not reusable", summary, {})
  assert.deepEqual(r, { kind: "skip", reason: "not reusable" })
})

test("draftSkill: update mode keeps the target name, otherwise retries", async () => {
  const existing = { name: "aggregate-csv-by-region", content: GOOD_DRAFT }
  const r1 = await draftSkill(async () => GOOD_DRAFT.replace("Check the delimiter first.", "Check the delimiter and header."), summary, { existing })
  assert.equal(r1.skill.name, "aggregate-csv-by-region")
  let n = 0
  const r2 = await draftSkill(async () => (n++, GOOD_DRAFT.replace("aggregate-csv-by-region", "renamed-skill")), summary, { existing })
  assert.equal(n, 2)
  assert.equal(r2.kind, "skip")
  assert.match(r2.reason, /name must stay/)
  assert.equal(r2.skill, undefined)
})

test("draftSkill: transport failure reason is redacted", async () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz123456"
  const r = await draftSkill(async () => { throw new Error(`route failed: ${secret}`) }, summary)
  assert.equal(r.kind, "skip")
  assert.ok(!r.reason.includes(secret))
  assert.match(r.reason, /draft failed/)
})
