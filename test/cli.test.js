import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { execute, splitArgs } from "../src/cli.js"
import { writeProposal } from "../src/store.js"
import { parseDraft } from "../src/draft.js"
import { GOOD_DRAFT, tmpHome } from "./helpers.js"

const bin = join(dirname(fileURLToPath(import.meta.url)), "../bin/scribe.js")
const seed = (home) => writeProposal(home, parseDraft(GOOD_DRAFT).skill, { sessionId: "s", turn: 1, taskSummary: "csv task" })

test("splitArgs handles quotes", () => {
  assert.deepEqual(splitArgs(`accept x --project "/a b/c"`), ["accept", "x", "--project", "/a b/c"])
})

test("list / show / diff / accept / reject round trip", (t) => {
  const home = tmpHome(t)
  assert.match(execute(["list"], { home }).text, /no pending/)
  seed(home)
  assert.match(execute(["list"], { home }).text, /aggregate-csv-by-region\tnew/)
  const show = execute(["show", "aggregate-csv-by-region"], { home })
  assert.match(show.text, /"kind": "new"/)
  assert.match(show.text, /## Steps/)
  assert.match(execute(["diff", "aggregate-csv-by-region"], { home }).text, /new skill/)
  const acc = execute(["accept", "aggregate-csv-by-region"], { home })
  assert.equal(acc.code, 0)
  assert.ok(existsSync(join(home, "skills/aggregate-csv-by-region/SKILL.md")))
  seed(home)
  const rej = execute(["reject", "aggregate-csv-by-region"], { home })
  assert.equal(rej.code, 0)
  assert.ok(existsSync(join(home, "skill-scribe/rejected/aggregate-csv-by-region/SKILL.md")))
})

test("errors give non-zero codes and messages", (t) => {
  const home = tmpHome(t)
  assert.equal(execute([], { home }).code, 1)
  assert.equal(execute(["bogus"], { home }).code, 2)
  assert.equal(execute(["show"], { home }).code, 1)
  assert.match(execute(["show", "nope"], { home }).text, /no such proposal/)
  assert.match(execute(["accept", "../etc"], { home }).text, /invalid proposal id/)
  assert.match(execute(["accept", "x", "--project"], { home }).text, /needs a value/)
})

test("update acceptance defaults to skills home and reports unchanged source", (t) => {
  const home = tmpHome(t)
  const source = join(tmpHome(t), "source", "aggregate-csv-by-region", "SKILL.md")
  mkdirSync(dirname(source), { recursive: true })
  writeFileSync(source, "old skill\n")
  const proposal = writeProposal(home, parseDraft(GOOD_DRAFT).skill, {
    sessionId: "s", turn: 1, kind: "update", target: "aggregate-csv-by-region", targetPath: source,
  })
  const result = execute(["accept", proposal.meta.id], { home })
  assert.equal(result.code, 0)
  assert.ok(result.text.includes(`source: ${source} (unchanged)`))
  assert.equal(readFileSync(source, "utf8"), "old skill\n")
  assert.ok(existsSync(join(home, "skills/aggregate-csv-by-region/SKILL.md")))
})

test("update acceptance recognizes a symlink alias to its destination", (t) => {
  const home = tmpHome(t)
  const skillDir = join(home, "skills", "aggregate-csv-by-region")
  mkdirSync(skillDir, { recursive: true })
  const destination = join(skillDir, "SKILL.md")
  writeFileSync(destination, "old skill\n")
  const alias = join(tmpHome(t), "skill-alias")
  symlinkSync(join(home, "skills"), alias, "dir")
  const source = join(alias, "aggregate-csv-by-region", "SKILL.md")
  const proposal = writeProposal(home, parseDraft(GOOD_DRAFT).skill, {
    sessionId: "s", turn: 1, kind: "update", target: "aggregate-csv-by-region", targetPath: source,
  })

  const result = execute(["accept", proposal.meta.id], { home })
  assert.equal(result.code, 0)
  assert.ok(!result.text.includes("(unchanged)"))
  assert.equal(readFileSync(destination, "utf8"), readFileSync(join(home, "skill-scribe", "accepted", proposal.meta.id, "SKILL.md"), "utf8"))
  assert.match(result.text, /backup:/)
})

test("bin/scribe.js works as a real process with DSH_HOME", (t) => {
  const home = tmpHome(t)
  seed(home)
  const env = { ...process.env, DSH_HOME: home }
  const list = spawnSync(process.execPath, [bin, "list"], { env, encoding: "utf8" })
  assert.equal(list.status, 0)
  assert.match(list.stdout, /aggregate-csv-by-region/)
  const proj = tmpHome(t)
  const acc = spawnSync(process.execPath, [bin, "accept", "aggregate-csv-by-region", "--project", proj], { env, encoding: "utf8" })
  assert.equal(acc.status, 0, acc.stderr)
  assert.match(readFileSync(join(proj, ".dsh/skills/aggregate-csv-by-region/SKILL.md"), "utf8"), /^name: aggregate-csv-by-region$/m)
  const bad = spawnSync(process.execPath, [bin, "show", "gone"], { env, encoding: "utf8" })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /no such proposal/)
})
