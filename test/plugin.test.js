import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { install } from "../index.js"
import { listProposals } from "../src/store.js"
import { GOOD_DRAFT, tmpHome, turnEvents } from "./helpers.js"

/** Minimal cordis-like context that records handlers, effects and injected commands. */
function fakeCtx() {
  const handlers = {}
  const effects = []
  const commands = []
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on: (name, fn) => { (handlers[name] ??= []).push(fn) },
    effect: (fn) => { effects.push(fn()) },
    inject: (_names, cb) => cb({ effect: (fn) => effects.push(fn()), commands: { register: (d) => (commands.push(d), () => {}) } }),
    skills: { get: async () => undefined },
  }
  const emit = (session, e) => handlers["session/event"].forEach((h) => h(session, e))
  const shutdown = async () => { for (const d of effects) if (typeof d === "function") await d() }
  return { ctx, emit, commands, shutdown, handlers }
}

const session = (id = "session-p") => ({ id, header: { cwd: "/w", delegationDepth: 0 } })
const tick = () => new Promise((r) => setTimeout(r, 20))
const stubLlm = (text = GOOD_DRAFT, counter = { n: 0 }) => () => async () => (counter.n++, text)

test("a qualifying turn produces a proposal without blocking the event handler", async (t) => {
  const home = tmpHome(t)
  const f = fakeCtx()
  let release
  const gateP = new Promise((r) => (release = r))
  install(f.ctx, { home }, { makeLlm: () => async () => (await gateP, GOOD_DRAFT) })
  const s = session()
  const t0 = Date.now()
  for (const e of turnEvents()) f.emit(s, e)
  assert.ok(Date.now() - t0 < 50, "event handler must return immediately")
  assert.deepEqual(listProposals(home), []) // LLM still pending
  release()
  await f.shutdown() // drains
  assert.equal(listProposals(home).length, 1)
})

test("at most one draft per session at a time", async (t) => {
  const home = tmpHome(t)
  const f = fakeCtx()
  const counter = { n: 0 }
  let release
  const gateP = new Promise((r) => (release = r))
  install(f.ctx, { home }, { makeLlm: () => async () => (counter.n++, await gateP, GOOD_DRAFT) })
  const s = session()
  for (const e of turnEvents()) f.emit(s, e)
  for (const e of turnEvents()) f.emit(s, e) // second turn while the first draft is running
  await tick()
  assert.equal(counter.n, 1)
  release()
  await f.shutdown()
  assert.equal(listProposals(home).length, 1)
  // another session is independent
  for (const e of turnEvents()) f.emit(session("other"), e)
  await f.shutdown()
  assert.equal(listProposals(home).length, 2)
})

test("non-qualifying turns and sub-agent sessions are ignored", async (t) => {
  const home = tmpHome(t)
  const f = fakeCtx()
  const counter = { n: 0 }
  install(f.ctx, { home }, { makeLlm: stubLlm(GOOD_DRAFT, counter) })
  for (const e of turnEvents({ calls: 2 })) f.emit(session(), e)
  for (const e of turnEvents({ endKind: "aborted" })) f.emit(session(), e)
  for (const e of turnEvents()) f.emit({ id: "sub", header: { delegationDepth: 1 } }, e)
  await f.shutdown()
  assert.equal(counter.n, 0)
  assert.deepEqual(listProposals(home), [])
})

test("enabled:false registers nothing", (t) => {
  const f = fakeCtx()
  install(f.ctx, { home: tmpHome(t), enabled: false }, { makeLlm: stubLlm() })
  assert.equal(f.handlers["session/event"], undefined)
  assert.equal(f.commands.length, 0)
})

test("minToolCalls from config is honoured", async (t) => {
  const home = tmpHome(t)
  const f = fakeCtx()
  install(f.ctx, { home, minToolCalls: 5 }, { makeLlm: stubLlm() })
  for (const e of turnEvents({ calls: 4 })) f.emit(session(), e)
  await f.shutdown()
  assert.deepEqual(listProposals(home), [])
})

test("a missing LLM route writes no proposal and logs why", async (t) => {
  const home = tmpHome(t)
  const f = fakeCtx()
  const logged = []
  f.ctx.logger.info = (line) => logged.push(line)
  f.ctx.logger.warn = (line) => logged.push(line)
  install(f.ctx, { home }, { makeLlm: () => { throw new Error("no model route") } })
  for (const e of turnEvents()) f.emit(session(), e)
  await f.shutdown()
  assert.deepEqual(listProposals(home), [])
  assert.match(logged.join("\n"), /no LLM available.*no model route/)
  assert.match(logged.join("\n"), /no proposal.*draft failed/)
})

test("two invalid LLM drafts leave no proposal", async (t) => {
  const home = tmpHome(t)
  const f = fakeCtx()
  const logged = []
  let calls = 0
  f.ctx.logger.info = (line) => logged.push(line)
  install(f.ctx, { home }, { makeLlm: () => async () => (calls++, "invalid draft") })
  for (const e of turnEvents()) f.emit(session(), e)
  await f.shutdown()
  assert.equal(calls, 2)
  assert.deepEqual(listProposals(home), [])
  assert.match(logged.join("\n"), /no proposal.*draft failed/)
})

test("plugin logger redacts secret values from LLM errors", async (t) => {
  const home = tmpHome(t)
  const key = "SCRIBE_TEST_PASSWORD"
  const old = process.env[key]
  process.env[key] = "synthetic-log-value-94138"
  try {
    const f = fakeCtx()
    const logged = []
    f.ctx.logger.warn = (line) => logged.push(line)
    install(f.ctx, { home }, { makeLlm: () => { throw new Error(`route ${process.env[key]} failed`) } })
    for (const e of turnEvents()) f.emit(session(), e)
    await f.shutdown()
    assert.ok(logged.length > 0)
    assert.ok(!logged.join("\n").includes(process.env[key]))
  } finally {
    if (old === undefined) delete process.env[key]
    else process.env[key] = old
  }
})

test("shutdown aborts a slow draft after the grace period without writing a proposal", async (t) => {
  const home = tmpHome(t)
  const f = fakeCtx()
  const logged = []
  f.ctx.logger.info = (line) => logged.push(line)
  install(f.ctx, { home, shutdownGraceMs: 100 }, {
    makeLlm: (_c, _s, _cfg, signal) => () => new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new Error("interrupted by dsh shutdown")))),
  })
  for (const e of turnEvents()) f.emit(session(), e)
  const t0 = Date.now()
  await f.shutdown()
  assert.ok(Date.now() - t0 < 1500)
  assert.deepEqual(listProposals(home), [])
  assert.match(logged.join("\n"), /no proposal.*interrupted by dsh shutdown/)
})

test("/scribe command is registered and drives list/accept", async (t) => {
  const home = tmpHome(t)
  const f = fakeCtx()
  install(f.ctx, { home }, { makeLlm: stubLlm() })
  for (const e of turnEvents()) f.emit(session(), e)
  await f.shutdown()
  const cmd = f.commands.find((c) => c.name === "scribe")
  assert.ok(cmd)
  const list = cmd.handler({ rawInput: "list" })
  assert.equal(list.kind, "success")
  assert.match(list.text, /aggregate-csv-by-region/)
  assert.equal(cmd.handler({ rawInput: "show nope" }).kind, "error")
  const acc = cmd.handler({ rawInput: "accept aggregate-csv-by-region" })
  assert.equal(acc.kind, "success")
  assert.ok(existsSync(join(home, "skills/aggregate-csv-by-region/SKILL.md")))
})

test("nothing is activated by drafting alone", async (t) => {
  const home = tmpHome(t)
  const f = fakeCtx()
  install(f.ctx, { home }, { makeLlm: stubLlm() })
  for (const e of turnEvents()) f.emit(session(), e)
  await f.shutdown()
  assert.equal(listProposals(home).length, 1)
  assert.ok(!existsSync(join(home, "skills")))
})
