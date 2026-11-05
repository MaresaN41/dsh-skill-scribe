import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import {
  acceptProposal, diffProposal, layout, lineDiff, listProposals, quotaLeft, readProposal, rejectProposal, writeProposal,
} from "../src/store.js"
import { GOOD_DRAFT, tmpHome } from "./helpers.js"
import { parseDraft } from "../src/draft.js"

const skill = () => parseDraft(GOOD_DRAFT).skill
const meta = (extra = {}) => ({ sessionId: "s1", turn: 1, taskSummary: "task", ...extra })

test("writeProposal writes SKILL.md and meta.json under proposed/", (t) => {
  const home = tmpHome(t)
  const r = writeProposal(home, skill(), meta())
  assert.equal(r.id, "aggregate-csv-by-region")
  assert.ok(existsSync(join(home, "skill-scribe/proposed/aggregate-csv-by-region/SKILL.md")))
  const m = JSON.parse(readFileSync(join(r.dir, "meta.json"), "utf8"))
  assert.equal(m.sessionId, "s1")
  assert.equal(m.turn, 1)
  assert.equal(m.kind, "new")
  assert.ok(Date.parse(m.createdAt))
  assert.equal(m.taskSummary, "task")
})

test("proposals are not in any skill search location", (t) => {
  const home = tmpHome(t)
  writeProposal(home, skill(), meta())
  assert.ok(!existsSync(join(home, "skills")))
})

test("same name never overwrites: numeric suffix, and the skill name follows", (t) => {
  const home = tmpHome(t)
  const a = writeProposal(home, skill(), meta())
  const b = writeProposal(home, skill(), meta())
  const c = writeProposal(home, skill(), meta())
  assert.deepEqual([a.id, b.id, c.id], ["aggregate-csv-by-region", "aggregate-csv-by-region-2", "aggregate-csv-by-region-3"])
  assert.match(readProposal(home, b.id).content, /^name: aggregate-csv-by-region-2$/m)
  assert.match(readProposal(home, a.id).content, /^name: aggregate-csv-by-region$/m)
})

test("secrets in the taskSummary and body are redacted on write", (t) => {
  const home = tmpHome(t)
  const s = { ...skill(), body: `# T\n\n1. export OPENAI_API_KEY=hunter2hunter2 then run` }
  const r = writeProposal(home, s, meta({ taskSummary: "use Bearer abcdefgh12345678" }))
  assert.ok(!readFileSync(join(r.dir, "SKILL.md"), "utf8").includes("hunter2hunter2"))
  assert.ok(!readFileSync(join(r.dir, "meta.json"), "utf8").includes("abcdefgh12345678"))
})

test("all metadata is redacted and derived identity fields cannot be overridden", (t) => {
  const home = tmpHome(t)
  const r = writeProposal(home, skill(), meta({
    id: "wrong", skillName: "wrong", kind: "new", createdAt: "wrong",
    draftErrors: ["Bearer abcdefgh12345678"], nested: { note: "OPENAI_API_KEY=hunter2hunter2" },
  }))
  const saved = readFileSync(join(r.dir, "meta.json"), "utf8")
  assert.ok(!saved.includes("abcdefgh12345678"))
  assert.ok(!saved.includes("hunter2hunter2"))
  assert.equal(r.meta.id, r.id)
  assert.equal(r.meta.skillName, skill().name)
  assert.equal(r.meta.kind, "new")
  assert.notEqual(r.meta.createdAt, "wrong")
})

test("listProposals is sorted by creation time", (t) => {
  const home = tmpHome(t)
  writeProposal(home, { ...skill(), name: "bbb-skill" }, meta(), new Date("2026-01-02T00:00:00Z"))
  writeProposal(home, { ...skill(), name: "aaa-skill" }, meta(), new Date("2026-01-01T00:00:00Z"))
  assert.deepEqual(listProposals(home).map((m) => m.id), ["aaa-skill", "bbb-skill"])
  assert.deepEqual(listProposals(tmpHome(t)), [])
})

test("daily quota counts proposals and resets the next day", (t) => {
  const home = tmpHome(t)
  const d1 = new Date(2026, 0, 1, 12)
  assert.equal(quotaLeft(home, 2, d1), 2)
  writeProposal(home, { ...skill(), name: "one-skill" }, meta(), d1)
  assert.equal(quotaLeft(home, 2, d1), 1)
  writeProposal(home, { ...skill(), name: "two-skill" }, meta(), d1)
  assert.equal(quotaLeft(home, 2, d1), 0)
  assert.equal(quotaLeft(home, 2, new Date(2026, 0, 2, 12)), 2)
})

test("accept installs into $DSH_HOME/skills/<name>/SKILL.md and archives the proposal", (t) => {
  const home = tmpHome(t)
  const { id } = writeProposal(home, skill(), meta())
  const r = acceptProposal(home, id)
  assert.equal(r.destination, join(home, "skills/aggregate-csv-by-region/SKILL.md"))
  assert.equal(r.backup, undefined)
  assert.match(readFileSync(r.destination, "utf8"), /^name: aggregate-csv-by-region$/m)
  assert.ok(!existsSync(join(home, "skill-scribe/proposed", id)))
  assert.ok(existsSync(join(home, "skill-scribe/accepted", id, "meta.json")))
  assert.deepEqual(listProposals(home), [])
})

test("accept --project installs into <project>/.dsh/skills", (t) => {
  const home = tmpHome(t)
  const project = tmpHome(t)
  const { id } = writeProposal(home, skill(), meta())
  const r = acceptProposal(home, id, { project })
  assert.equal(r.destination, join(project, ".dsh/skills/aggregate-csv-by-region/SKILL.md"))
  assert.ok(!existsSync(join(home, "skills")))
})

test("accept over an existing skill leaves a SKILL.md.bak-<timestamp> the scanner ignores", (t) => {
  const home = tmpHome(t)
  const dest = join(home, "skills/aggregate-csv-by-region")
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, "SKILL.md"), "OLD CONTENT")
  const { id } = writeProposal(home, skill(), meta())
  const r = acceptProposal(home, id, {}, new Date(2026, 9, 30, 12, 34, 56))
  assert.equal(r.backup, join(dest, "SKILL.md.bak-20261030-123456"))
  assert.equal(readFileSync(r.backup, "utf8"), "OLD CONTENT")
  assert.match(readFileSync(r.destination, "utf8"), /aggregate-csv-by-region/)
  // The skill filesystem scans only `SKILL.md` (and top-level `<name>.md`): the backup name must not match.
  assert.ok(readdirSync(dest).filter((f) => f === "SKILL.md" || f.endsWith(".md")).length === 1)
})

test("update proposals diff the source but accept into DSH_HOME by default", (t) => {
  const home = tmpHome(t)
  const orig = join(tmpHome(t), "aggregate-csv-by-region")
  mkdirSync(orig)
  const origFile = join(orig, "SKILL.md")
  writeFileSync(origFile, GOOD_DRAFT)
  const improved = { ...skill(), body: skill().body + "\n- Quote fields that contain commas." }
  const { id, meta: m } = writeProposal(home, improved, meta({ kind: "update", target: "aggregate-csv-by-region", targetPath: origFile }))
  assert.equal(id, "aggregate-csv-by-region-update")
  assert.equal(m.kind, "update")
  assert.equal(m.target, "aggregate-csv-by-region")
  const d = diffProposal(home, id)
  assert.match(d, /^\+- Quote fields that contain commas\.$/m)
  const project = tmpHome(t)
  assert.match(diffProposal(home, id, { project }), /new skill:/)
  const r = acceptProposal(home, id)
  assert.equal(r.destination, join(home, "skills/aggregate-csv-by-region/SKILL.md"))
  assert.equal(r.backup, undefined)
  assert.equal(readFileSync(origFile, "utf8"), GOOD_DRAFT)
  assert.match(readFileSync(r.destination, "utf8"), /Quote fields/)
})

test("same-second backups and archives preserve every previous file", (t) => {
  const home = tmpHome(t)
  const when = new Date(2026, 9, 30, 12, 34, 56)
  const dest = join(home, "skills/aggregate-csv-by-region")
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, "SKILL.md"), "ORIGINAL")
  const first = writeProposal(home, skill(), meta())
  const a = acceptProposal(home, first.id, {}, when)
  const firstContent = readFileSync(a.destination, "utf8")
  const second = writeProposal(home, skill(), meta())
  const b = acceptProposal(home, second.id, {}, when)
  assert.notEqual(a.backup, b.backup)
  assert.equal(readFileSync(a.backup, "utf8"), "ORIGINAL")
  assert.equal(readFileSync(b.backup, "utf8"), firstContent)
  assert.equal(readFileSync(join(layout(home).accepted, first.id, "SKILL.md"), "utf8"), firstContent)
  assert.equal(second.id, first.id)
  const third = writeProposal(home, skill(), meta())
  acceptProposal(home, third.id, {}, when)
  assert.equal(readdirSync(layout(home).accepted).length, 3)
  assert.equal(readFileSync(a.backup, "utf8"), "ORIGINAL")
  assert.equal(readFileSync(b.backup, "utf8"), firstContent)
})

test("proposal and destination symlinks cannot redirect writes", (t) => {
  const home = tmpHome(t)
  const outside = tmpHome(t)
  const p = writeProposal(home, skill(), meta())
  const proposalDir = p.dir
  const moved = join(outside, "proposal")
  renameSync(proposalDir, moved)
  symlinkSync(moved, proposalDir, "dir")
  assert.throws(() => acceptProposal(home, p.id), /symbolic link/)
  assert.ok(!existsSync(join(home, "skills")))
  const q = writeProposal(home, { ...skill(), name: "other-skill" }, meta())
  mkdirSync(join(home, "skills"))
  symlinkSync(outside, join(home, "skills/other-skill"), "dir")
  assert.throws(() => acceptProposal(home, q.id), /symbolic link/)
  assert.ok(!existsSync(join(outside, "SKILL.md")))
})

test("accepted archive symlink blocks accept before destination or backup changes", (t) => {
  const home = tmpHome(t)
  const outside = tmpHome(t)
  const { id, dir } = writeProposal(home, skill(), meta())
  const destinationDir = join(home, "skills", skill().name)
  mkdirSync(destinationDir, { recursive: true })
  writeFileSync(join(destinationDir, "SKILL.md"), "ORIGINAL")
  symlinkSync(outside, layout(home).accepted, "dir")
  assert.throws(() => acceptProposal(home, id), /symbolic link/)
  assert.equal(readFileSync(join(destinationDir, "SKILL.md"), "utf8"), "ORIGINAL")
  assert.deepEqual(readdirSync(destinationDir), ["SKILL.md"])
  assert.ok(existsSync(join(dir, "meta.json")))
  assert.deepEqual(readdirSync(outside), [])
})

test("accepted archive symlink blocks creation of a new destination", (t) => {
  const home = tmpHome(t)
  const outside = tmpHome(t)
  const { id, dir } = writeProposal(home, skill(), meta())
  symlinkSync(outside, layout(home).accepted, "dir")
  assert.throws(() => acceptProposal(home, id), /symbolic link/)
  assert.ok(!existsSync(join(home, "skills")))
  assert.ok(existsSync(dir))
  assert.deepEqual(readdirSync(outside), [])
})

test("rejected archive symlink leaves the proposal pending", (t) => {
  const home = tmpHome(t)
  const outside = tmpHome(t)
  const { id, dir } = writeProposal(home, skill(), meta())
  symlinkSync(outside, layout(home).rejected, "dir")
  assert.throws(() => rejectProposal(home, id), /symbolic link/)
  assert.ok(existsSync(join(dir, "meta.json")))
  assert.deepEqual(readdirSync(outside), [])
})

test("proposed root symlink is rejected before creating folders through it", (t) => {
  const home = tmpHome(t)
  const outside = tmpHome(t)
  mkdirSync(join(home, "skill-scribe"))
  symlinkSync(outside, join(home, "skill-scribe/proposed"), "dir")
  assert.throws(() => writeProposal(home, skill(), meta()), /symbolic link/)
  assert.deepEqual(readdirSync(outside), [])
})

test("home and explicit destination aliases work while links below each root stay blocked", (t) => {
  const realHome = tmpHome(t)
  const aliases = tmpHome(t)
  const alias = join(aliases, "home-link")
  symlinkSync(realHome, alias, "dir")
  const p = writeProposal(alias, skill(), meta())
  assert.equal(p.dir, join(realHome, "skill-scribe/proposed", p.id))
  const destRoot = tmpHome(t)
  const destAlias = join(aliases, "dest-link")
  symlinkSync(destRoot, destAlias, "dir")
  const accepted = acceptProposal(alias, p.id, { dest: destAlias })
  assert.equal(accepted.destination, join(destRoot, "aggregate-csv-by-region/SKILL.md"))
  const project = join(aliases, "project-link")
  symlinkSync(destRoot, project, "dir")
  const q = writeProposal(alias, { ...skill(), name: "other-skill" }, meta())
  assert.equal(acceptProposal(alias, q.id, { project }).destination, join(destRoot, ".dsh/skills/other-skill/SKILL.md"))
  symlinkSync(tmpHome(t), join(destRoot, "linked-skill"), "dir")
  const r = writeProposal(alias, { ...skill(), name: "linked-skill" }, meta())
  assert.throws(() => acceptProposal(alias, r.id, { dest: destAlias }), /symbolic link/)
  const missingHome = join(alias, "new", "nested")
  const s = writeProposal(missingHome, { ...skill(), name: "nested-skill" }, meta())
  assert.equal(s.dir, join(realHome, "new/nested/skill-scribe/proposed/nested-skill"))
})

test("legacy count and a crashed slot are respected without a persistent lock", (t) => {
  const home = tmpHome(t)
  const when = new Date(2026, 0, 2, 12)
  const l = layout(home)
  mkdirSync(l.root, { recursive: true })
  writeFileSync(l.state, JSON.stringify({ date: "2026-01-02", count: 1 }))
  assert.equal(quotaLeft(home, 2, when), 1)
  const r = writeProposal(home, skill(), meta(), when, 2)
  assert.ok(existsSync(join(l.root, "quota/2026-01-02/1")))
  assert.equal(quotaLeft(home, 2, when), 0)
  assert.throws(() => writeProposal(home, skill(), meta(), when, 2), { code: "SCRIBE_DAILY_LIMIT" })
  assert.ok(existsSync(r.dir))
  assert.equal(quotaLeft(home, 2, new Date(2026, 0, 3, 12)), 2)
})

test("crash during state write leaves prior JSON intact while the reserved slot counts", (t) => {
  const home = tmpHome(t)
  const when = new Date("2026-01-02T12:00:00Z")
  writeProposal(home, skill(), meta(), when, 2)
  const l = layout(home)
  const before = readFileSync(l.state, "utf8")
  assert.equal(JSON.parse(before).count, 1)
  const moduleUrl = new URL("../src/store.js", import.meta.url).href
  const code = `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
    const original = fs.writeFileSync;
    fs.writeFileSync = (path, data, options) => {
      if (/(?:\\/state\\.json|\\/\\.state-[^/]+\\.tmp)$/.test(String(path))) {
        original(path, String(data).slice(0, 3), options); process.exit(73);
      }
      return original(path, data, options);
    };
    syncBuiltinESMExports();
    const { writeProposal } = await import(${JSON.stringify(moduleUrl)});
    writeProposal(process.argv[1], {name:"second-skill",description:"Second",whenToUse:"Second",body:"# Second\\n\\n1. Write a valid proposal."}, {sessionId:"child",turn:2,taskSummary:"crash"}, new Date("2026-01-02T12:00:00Z"), 2);`
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code, home], { encoding: "utf8" })
  assert.equal(child.status, 73, child.stderr)
  assert.equal(readFileSync(l.state, "utf8"), before)
  assert.ok(existsSync(join(l.root, "quota/2026-01-02/0")))
  assert.ok(existsSync(join(l.root, "quota/2026-01-02/1")))
  assert.equal(quotaLeft(home, 2, when), 0)
  const tomorrow = new Date("2026-01-03T12:00:00Z")
  assert.equal(quotaLeft(home, 2, tomorrow), 2)
  assert.ok(existsSync(writeProposal(home, { ...skill(), name: "next-day-skill" }, meta(), tomorrow, 2).dir))
  assert.equal(quotaLeft(home, 2, tomorrow), 1)
})

test("crash during accept or reject metadata update keeps archived provenance intact", (t) => {
  const moduleUrl = new URL("../src/store.js", import.meta.url).href
  for (const action of ["accept", "reject"]) {
    const home = tmpHome(t)
    const { id, dir } = writeProposal(home, skill(), meta({ source: "synthetic" }))
    const originalMeta = readFileSync(join(dir, "meta.json"), "utf8")
    const destinationDir = join(home, "skills", skill().name)
    if (action === "accept") {
      mkdirSync(destinationDir, { recursive: true })
      writeFileSync(join(destinationDir, "SKILL.md"), "ORIGINAL")
    }
    const code = `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
      const original = fs.writeFileSync;
      fs.writeFileSync = (path, data, options) => {
        if (/\\/(?:accepted|rejected)\\/[^/]+\\/(?:meta\\.json|\\.meta-[^/]+\\.tmp)$/.test(String(path))) {
          original(path, String(data).slice(0, 3), options); process.exit(73);
        }
        return original(path, data, options);
      };
      syncBuiltinESMExports();
      const { acceptProposal, rejectProposal } = await import(${JSON.stringify(moduleUrl)});
      if (process.argv[2] === "accept") acceptProposal(process.argv[1], process.argv[3]);
      else rejectProposal(process.argv[1], process.argv[3]);`
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code, home, action, id], { encoding: "utf8" })
    assert.equal(child.status, 73, `${action}: ${child.stderr}`)
    const archived = join(layout(home)[action === "accept" ? "accepted" : "rejected"], id)
    assert.equal(readFileSync(join(archived, "meta.json"), "utf8"), originalMeta)
    assert.equal(JSON.parse(readFileSync(join(archived, "meta.json"), "utf8")).source, "synthetic")
    assert.ok(!existsSync(dir))
    if (action === "accept") {
      assert.match(readFileSync(join(destinationDir, "SKILL.md"), "utf8"), /aggregate-csv-by-region/)
      const backup = readdirSync(destinationDir).find((name) => name.startsWith("SKILL.md.bak-"))
      assert.equal(readFileSync(join(destinationDir, backup), "utf8"), "ORIGINAL")
    }
  }
})

test("a reserved slot without state leaves the next slot usable", (t) => {
  const home = tmpHome(t)
  const when = new Date("2026-01-02T12:00:00Z")
  const slots = join(layout(home).root, "quota/2026-01-02")
  mkdirSync(slots, { recursive: true })
  writeFileSync(join(slots, "0"), "")
  assert.equal(quotaLeft(home, 2, when), 1)
  assert.ok(existsSync(writeProposal(home, skill(), meta(), when, 2).dir))
  assert.ok(existsSync(join(slots, "1")))
  assert.equal(quotaLeft(home, 2, when), 0)
})

test("four barrier-released processes reserve at most two daily slots and unique ids", async (t) => {
  const home = tmpHome(t)
  const barrier = join(home, "go")
  const moduleUrl = new URL("../src/store.js", import.meta.url).href
  const code = `import { existsSync } from "node:fs"; import { writeProposal } from ${JSON.stringify(moduleUrl)};
    console.log("READY"); while (!existsSync(process.argv[2])) await new Promise(r => setTimeout(r, 2));
    try { const r = writeProposal(process.argv[1], {name:"race-skill",description:"Race",whenToUse:"Race",body:"# Race\\n\\n1. Write a valid proposal."}, {sessionId:process.pid,turn:1,taskSummary:"race"}, new Date("2026-01-02T12:00:00Z"), 2); console.log(JSON.stringify({id:r.id,status:"proposed"})); }
    catch(e) { console.log(JSON.stringify({status:e.code === "SCRIBE_DAILY_LIMIT" ? "limited" : "error", error:e.message})); }`
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, ["--input-type=module", "-e", code, home, barrier], { stdio: ["ignore", "pipe", "pipe"] }))
  const ready = children.map((child) => new Promise((resolve, reject) => {
    child.stdout.once("data", (data) => data.toString().includes("READY") ? resolve() : reject(new Error(data.toString())))
    child.once("error", reject)
    child.once("exit", (code) => { if (code) reject(new Error(`child exited ${code}`)) })
  }))
  await Promise.all(ready)
  writeFileSync(barrier, "go")
  const outputs = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    let out = "", err = ""
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (err += d))
    child.on("close", (code) => code === 0 ? resolve(JSON.parse(out.trim())) : reject(new Error(err || `exit ${code}`)))
  })))
  const made = outputs.filter((x) => x.status === "proposed")
  assert.equal(made.length, 2, JSON.stringify(outputs))
  assert.equal(new Set(made.map((x) => x.id)).size, 2)
  assert.ok(outputs.every((x) => ["proposed", "limited"].includes(x.status)), JSON.stringify(outputs))
  assert.equal(listProposals(home).length, 2)
  assert.equal(quotaLeft(home, 2, new Date("2026-01-02T12:00:00Z")), 0)
  assert.ok(JSON.parse(readFileSync(layout(home).state, "utf8")).count >= 1)
  assert.equal(quotaLeft(home, 2, new Date("2026-01-03T12:00:00Z")), 2)
})

test("diff of a new skill says so", (t) => {
  const home = tmpHome(t)
  const { id } = writeProposal(home, skill(), meta())
  assert.match(diffProposal(home, id), /new skill/)
})

test("lineDiff marks additions and removals", () => {
  const d = lineDiff("a\nb\nc", "a\nx\nc")
  assert.match(d, /^-b$/m)
  assert.match(d, /^\+x$/m)
  assert.match(lineDiff("same", "same"), /no differences/)
})

test("lineDiff uses a whole-file replacement above the matrix limit", () => {
  const oldText = Array.from({ length: 1001 }, (_, i) => `old-${i}`).join("\n")
  const newText = Array.from({ length: 1001 }, (_, i) => `new-${i}`).join("\n")
  const diff = lineDiff(oldText, newText, "old", "new")
  assert.ok(diff.startsWith("--- old\n+++ new\n-old-0\n"))
  assert.match(diff, /^-old-1000$/m)
  assert.match(diff, /^\+new-0$/m)
  assert.match(diff, /^\+new-1000$/m)
  assert.match(lineDiff(oldText, oldText), /no differences/)
})

test("missing, malformed, and inconsistent proposal metadata cannot be shown or accepted", (t) => {
  for (const invalid of [undefined, "{bad", "[]", "null", { id: "other", skillName: skill().name, kind: "new" }, { id: skill().name, skillName: "other-skill", kind: "new" }, { id: skill().name, skillName: [], kind: "new" }, { id: skill().name, skillName: skill().name, kind: "other" }, { id: skill().name, skillName: skill().name, kind: "update" }]) {
    const home = tmpHome(t)
    const { id, dir } = writeProposal(home, skill(), meta())
    const metaPath = join(dir, "meta.json")
    if (invalid === undefined) unlinkSync(metaPath)
    else writeFileSync(metaPath, typeof invalid === "string" ? invalid : JSON.stringify(invalid))
    assert.throws(() => readProposal(home, id), /proposal metadata/)
    assert.throws(() => acceptProposal(home, id), /proposal metadata/)
    assert.deepEqual(listProposals(home), [])
    assert.ok(existsSync(dir))
    assert.ok(!existsSync(join(home, "skills")))
  }
})

test("update metadata must match the proposal id", (t) => {
  const home = tmpHome(t)
  const { id, dir } = writeProposal(home, skill(), meta({ kind: "update" }))
  const path = join(dir, "meta.json")
  const original = JSON.parse(readFileSync(path, "utf8"))
  writeFileSync(path, JSON.stringify({ ...original, skillName: "other-skill" }))
  assert.throws(() => acceptProposal(home, id), /proposal metadata/)
  assert.ok(existsSync(dir))
  assert.ok(!existsSync(join(home, "skills")))
})

test("tenth update proposal remains readable, listed, and acceptable", (t) => {
  const home = tmpHome(t)
  const proposals = Array.from({ length: 10 }, () => writeProposal(home, skill(), meta({ kind: "update" })))
  const tenth = proposals[9]
  assert.equal(tenth.id, `${skill().name}-update-10`)
  assert.equal(listProposals(home).length, 10)
  assert.equal(readProposal(home, tenth.id).meta.skillName, skill().name)
  assert.equal(acceptProposal(home, tenth.id).destination, join(home, "skills", skill().name, "SKILL.md"))
  assert.equal(listProposals(home).length, 9)
})

test("reject moves to rejected/ and never deletes", (t) => {
  const home = tmpHome(t)
  const { id } = writeProposal(home, skill(), meta())
  const r = rejectProposal(home, id)
  assert.equal(r.dir, join(home, "skill-scribe/rejected", id))
  assert.ok(existsSync(join(r.dir, "SKILL.md")))
  assert.ok(JSON.parse(readFileSync(join(r.dir, "meta.json"), "utf8")).rejectedAt)
  assert.ok(!existsSync(join(layout(home).proposed, id)))
  assert.ok(!existsSync(join(home, "skills")))
})

test("rejecting two proposals with the same id keeps both", (t) => {
  const home = tmpHome(t)
  rejectProposal(home, writeProposal(home, skill(), meta()).id)
  rejectProposal(home, writeProposal(home, skill(), meta()).id)
  assert.equal(readdirSync(layout(home).rejected).length, 2)
})

test("ids are validated: no path traversal, unknown ids error", (t) => {
  const home = tmpHome(t)
  for (const bad of ["../x", "a/b", "..", "A", "x y", ""]) {
    assert.throws(() => readProposal(home, bad), /invalid proposal id/)
    assert.throws(() => acceptProposal(home, bad), /invalid proposal id/)
    assert.throws(() => rejectProposal(home, bad), /invalid proposal id/)
  }
  assert.throws(() => readProposal(home, "nope"), /no such proposal/)
})

test("accept refuses a proposal whose edited SKILL.md lost its front matter", (t) => {
  const home = tmpHome(t)
  const { id, dir } = writeProposal(home, skill(), meta())
  writeFileSync(join(dir, "SKILL.md"), "no front matter")
  assert.throws(() => acceptProposal(home, id), /front matter/)
  assert.ok(existsSync(dir))
})

test("accept refuses a SKILL.md whose name no longer matches the proposal", (t) => {
  const home = tmpHome(t)
  const { id, dir } = writeProposal(home, skill(), meta())
  const file = join(dir, "SKILL.md")
  writeFileSync(file, readFileSync(file, "utf8").replace(`name: ${id}`, "name: another-skill"))
  assert.throws(() => acceptProposal(home, id), /does not match proposal skill/)
  assert.ok(!existsSync(join(home, "skills", id)))
  assert.ok(!existsSync(join(home, "skills", "another-skill")))
  assert.ok(existsSync(file))
})
