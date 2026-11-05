import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { resolveConfig } from "../src/config.js"
import { TurnCollector } from "../src/gate.js"
import { makeHttpLlm } from "../src/llm.js"
import { processTurn, resolveExisting } from "../src/scribe.js"
import { listProposals } from "../src/store.js"
import { GOOD_DRAFT, asstMsg, tmpHome, toolCall, toolResult, turnEnd, turnEvents, turnStart, userMsg } from "./helpers.js"

const cfg = (o) => resolveConfig(o)

function summaryOf(events) {
  const c = new TurnCollector()
  let s
  for (const e of events) s = c.feed("session-x", e) ?? s
  return s
}

test("processTurn proposes a new skill from a qualifying turn", async (t) => {
  const home = tmpHome(t)
  const r = await processTurn({ home, config: cfg({}), summary: summaryOf(turnEvents()), llm: async () => GOOD_DRAFT })
  assert.equal(r.status, "proposed")
  assert.equal(r.kind, "new")
  const [m] = listProposals(home)
  assert.equal(m.sessionId, "session-x")
  assert.equal(m.drafter, "llm")
  assert.equal(m.toolCallCount, 3)
})

test("processTurn does not call the LLM for a turn that fails the gate", async (t) => {
  const home = tmpHome(t)
  let called = false
  const llm = async () => ((called = true), GOOD_DRAFT)
  for (const events of [turnEvents({ calls: 2 }), turnEvents({ endKind: "error" }), turnEvents({ lastError: true })]) {
    const r = await processTurn({ home, config: cfg({}), summary: summaryOf(events), llm })
    assert.equal(r.status, "skipped")
  }
  assert.equal(called, false)
  assert.deepEqual(listProposals(home), [])
})

test("processTurn honours the model's SKIP", async (t) => {
  const home = tmpHome(t)
  const r = await processTurn({ home, config: cfg({}), summary: summaryOf(turnEvents()), llm: async () => "SKIP: one-off" })
  assert.deepEqual(r, { status: "skipped", reason: "model: one-off" })
  assert.deepEqual(listProposals(home), [])
})

test("processTurn stops at maxProposalsPerDay", async (t) => {
  const home = tmpHome(t)
  const config = cfg({ maxProposalsPerDay: 2 })
  const run = () => processTurn({ home, config, summary: summaryOf(turnEvents()), llm: async () => GOOD_DRAFT })
  assert.equal((await run()).status, "proposed")
  assert.equal((await run()).status, "proposed")
  assert.deepEqual(await run(), { status: "skipped", reason: "daily-limit" })
  assert.equal(listProposals(home).length, 2)
})

test("parallel turns do not exceed the daily proposal limit", async (t) => {
  const home = tmpHome(t)
  const config = cfg({ maxProposalsPerDay: 1 })
  let release
  const waiting = new Promise((resolve) => (release = resolve))
  const run = (id) => processTurn({
    home, config, summary: { ...summaryOf(turnEvents()), sessionId: id },
    llm: async () => (await waiting, GOOD_DRAFT),
  })
  const first = run("first")
  const second = run("second")
  release()
  const results = await Promise.all([first, second])
  assert.deepEqual(results.map((r) => r.status).sort(), ["proposed", "skipped"])
  assert.equal(listProposals(home).length, 1)
})

test("processTurn sends no secrets to the LLM", async (t) => {
  const home = tmpHome(t)
  const events = turnEvents({ task: "deploy with OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456" })
  let prompt = ""
  await processTurn({ home, config: cfg({}), summary: summaryOf(events), llm: async (s, u) => ((prompt = s + u), GOOD_DRAFT) })
  assert.ok(prompt.length > 0)
  assert.ok(!prompt.includes("sk-abcdefghijklmnopqrstuvwxyz123456"))
})

test("processTurn skips without a proposal when the LLM is down", async (t) => {
  const home = tmpHome(t)
  const r = await processTurn({
    home,
    config: cfg({}),
    summary: summaryOf(turnEvents()),
    llm: async () => {
      throw new Error("connection refused")
    },
  })
  assert.equal(r.status, "skipped")
  assert.match(r.reason, /connection refused/)
  assert.deepEqual(listProposals(home), [])
})

test("processTurn redacts secret values from LLM failure skip reasons", async (t) => {
  const home = tmpHome(t)
  const key = "SCRIBE_TEST_TOKEN"
  const old = process.env[key]
  process.env[key] = "synthetic-error-value-76241"
  try {
    const r = await processTurn({
      home, config: cfg({}), summary: summaryOf(turnEvents()),
      llm: async () => { throw new Error(`endpoint ${process.env[key]} failed`) },
    })
    assert.equal(r.status, "skipped")
    assert.ok(!r.reason.includes(process.env[key]))
    assert.deepEqual(listProposals(home), [])
  } finally {
    if (old === undefined) delete process.env[key]
    else process.env[key] = old
  }
})

function skillTurn(dir, name = "aggregate-csv-by-region") {
  return [
    turnStart(), userMsg("do the csv thing again"),
    toolCall("s", "skill", { name }),
    toolResult("s", `<skill_content name="${name}">\n<skill_resources>\nBase directory for this skill: ${dir}\n</skill_resources>`),
    ...[0, 1, 2].flatMap((i) => [toolCall(`c${i}`, "bash", { command: `step ${i}` }), toolResult(`c${i}`, "ok")]),
    asstMsg("done"), turnEnd(),
  ]
}

test("a turn that used an existing skill yields an update proposal with target and path", async (t) => {
  const home = tmpHome(t)
  const dir = join(tmpHome(t), "aggregate-csv-by-region")
  mkdirSync(dir)
  writeFileSync(join(dir, "SKILL.md"), GOOD_DRAFT)
  const improved = GOOD_DRAFT.replace("- Check the delimiter first.", "- Check the delimiter first.\n- Beware of quoted commas.")
  let prompt = ""
  const r = await processTurn({
    home, config: cfg({}), summary: summaryOf(skillTurn(dir)), llm: async (s, u) => ((prompt = u), improved),
    skillsGet: async () => ({ path: join(dir, "SKILL.md"), content: GOOD_DRAFT }),
  })
  assert.equal(r.status, "proposed")
  assert.equal(r.kind, "update")
  assert.match(prompt, /<existing_skill>/)
  const [m] = listProposals(home)
  assert.equal(m.kind, "update")
  assert.equal(m.target, "aggregate-csv-by-region")
  assert.equal(m.targetPath, join(dir, "SKILL.md"))
  assert.equal(m.id, "aggregate-csv-by-region-update")
  assert.ok(!existsSync(join(home, "skills")))
})

test("resolveExisting uses the registry lookup", async (t) => {
  const s = summaryOf(skillTurn("/does/not/exist"))
  const e = await resolveExisting(s, async (n) => ({ path: "/reg/x/SKILL.md", content: `content of ${n}` }))
  assert.equal(e.name, "aggregate-csv-by-region")
  assert.equal(e.content, "content of aggregate-csv-by-region")
  await assert.rejects(() => resolveExisting(s, undefined), /registry/)
})

test("skill result directory is never read; registry content is the only update source", async (t) => {
  const home = tmpHome(t)
  const dir = join(tmpHome(t), "aggregate-csv-by-region")
  mkdirSync(dir)
  writeFileSync(join(dir, "SKILL.md"), "SYNTHETIC_PRIVATE_MARKER")
  let prompt = ""
  const r = await processTurn({
    home, config: cfg({}), summary: summaryOf(skillTurn(dir)),
    skillsGet: async () => ({ path: "/trusted/aggregate-csv-by-region/SKILL.md", content: GOOD_DRAFT }),
    llm: async (_s, u) => ((prompt = u), GOOD_DRAFT),
  })
  assert.equal(r.status, "proposed")
  assert.ok(!prompt.includes("SYNTHETIC_PRIVATE_MARKER"))
  assert.match(prompt, /Check the delimiter first/)
  assert.equal(listProposals(home)[0].targetPath, "/trusted/aggregate-csv-by-region/SKILL.md")
})

test("used skill without a registry entry never becomes a new proposal", async (t) => {
  const home = tmpHome(t)
  let called = false
  const r = await processTurn({
    home, config: cfg({}), summary: summaryOf(skillTurn("/untrusted")),
    skillsGet: async () => undefined,
    llm: async () => ((called = true), GOOD_DRAFT),
  })
  assert.equal(r.status, "error")
  assert.match(r.error, /registry/)
  assert.equal(called, false)
  assert.deepEqual(listProposals(home), [])
})

test("makeHttpLlm posts an OpenAI-compatible request and returns the text", async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = { url, body: JSON.parse(init.body), auth: init.headers.authorization }
    return { ok: true, json: async () => ({ choices: [{ message: { content: "hello" } }] }) }
  }
  process.env.SCRIBE_TEST_KEY = "k-123"
  const llm = makeHttpLlm({ baseURL: "http://x/v1/", model: "m", apiKeyEnv: "SCRIBE_TEST_KEY" }, cfg({}), undefined, fetchImpl)
  assert.equal(await llm("sys", "usr"), "hello")
  assert.equal(seen.url, "http://x/v1/chat/completions")
  assert.equal(seen.body.model, "m")
  assert.equal(seen.body.messages[0].role, "system")
  assert.equal(seen.auth, "Bearer k-123")
  const bad = makeHttpLlm({ baseURL: "http://x/v1", model: "m" }, cfg({}), undefined, async () => ({ ok: false, status: 500 }))
  await assert.rejects(() => bad("s", "u"), /HTTP 500/)
})

test("config defaults match the spec", () => {
  const c = resolveConfig({})
  assert.equal(c.enabled, true)
  assert.equal(c.minToolCalls, 3)
  assert.equal(c.maxProposalsPerDay, 10)
  assert.equal(c.language, "auto")
  assert.equal(c.model, undefined)
  assert.equal(resolveConfig({ model: { provider: "p" } }).model, undefined)
})

test("proposal meta.json is readable JSON with the documented fields", async (t) => {
  const home = tmpHome(t)
  await processTurn({ home, config: cfg({}), summary: summaryOf(turnEvents()), llm: async () => GOOD_DRAFT })
  const m = JSON.parse(readFileSync(join(home, "skill-scribe/proposed/aggregate-csv-by-region/meta.json"), "utf8"))
  for (const k of ["id", "skillName", "sessionId", "turn", "createdAt", "taskSummary", "kind"]) assert.ok(k in m, k)
})
