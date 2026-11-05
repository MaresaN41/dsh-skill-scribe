// On-disk layout and the approve/reject operations. Only touches
// $DSH_HOME/skill-scribe/** and the destination of an accepted skill.

import {
  constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs"
import { randomUUID } from "node:crypto"
import { basename, dirname, join, parse, resolve, sep } from "node:path"
import { NAME_RE, parseFrontmatter, renderSkill } from "./draft.js"
import { redact, redactDeep } from "./redact.js"

export const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function canonicalRoot(path) {
  let existing = resolve(path)
  const missing = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) throw new Error(`no existing ancestor: ${path}`)
    missing.unshift(existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
    existing = parent
  }
  return join(realpathSync(existing), ...missing)
}

export function layout(home) {
  home = canonicalRoot(home)
  const root = join(home, "skill-scribe")
  return {
    root,
    proposed: join(root, "proposed"),
    rejected: join(root, "rejected"),
    accepted: join(root, "accepted"),
    state: join(root, "state.json"),
    skills: join(home, "skills"),
  }
}

export function timestamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return fallback
  }
}

function existsNoFollow(path) {
  try { lstatSync(path); return true } catch (e) { if (e.code === "ENOENT") return false; throw e }
}

function assertNoSymlink(path) {
  const full = resolve(path)
  let part = parse(full).root
  for (const segment of full.slice(part.length).split(sep).filter(Boolean)) {
    part = join(part, segment)
    try {
      if (lstatSync(part).isSymbolicLink()) throw new Error(`symbolic link in path: ${part}`)
    } catch (e) {
      if (e.code !== "ENOENT") throw e
    }
  }
}

function atomicWriteJson(path, data) {
  assertNoSymlink(path)
  const temp = join(dirname(path), `.${basename(path, ".json")}-${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", { flag: "wx" })
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

// ---- daily quota -----------------------------------------------------------

export function quotaLeft(home, max, now = new Date()) {
  const l = layout(home)
  const date = today(now)
  assertNoSymlink(l.state)
  const s = readJson(l.state, {})
  const slots = join(l.root, "quota", date)
  assertNoSymlink(slots)
  const numbers = existsSync(slots) ? readdirSync(slots).filter((n) => /^(0|[1-9][0-9]*)$/.test(n)).map(Number) : []
  const used = Math.max(s.date === date ? Number(s.count) || 0 : 0, numbers.length ? Math.max(...numbers) + 1 : 0)
  return Math.max(0, max - used)
}

function reserveQuota(home, max, now) {
  const l = layout(home)
  const date = today(now)
  const slots = join(l.root, "quota", date)
  assertNoSymlink(slots)
  mkdirSync(slots, { recursive: true })
  assertNoSymlink(slots)
  assertNoSymlink(l.state)
  const s = readJson(l.state, {})
  const numbers = readdirSync(slots).filter((n) => /^(0|[1-9][0-9]*)$/.test(n)).map(Number)
  let slot = Math.max(s.date === date ? Number(s.count) || 0 : 0, numbers.length ? Math.max(...numbers) + 1 : 0)
  for (; slot < max; slot++) {
    try { writeFileSync(join(slots, String(slot)), "", { flag: "wx" }); return slot + 1 }
    catch (e) { if (e.code !== "EEXIST") throw e }
  }
  const e = new Error("daily proposal limit reached")
  e.code = "SCRIBE_DAILY_LIMIT"
  throw e
}

function bumpQuota(home, count, now) {
  const l = layout(home)
  atomicWriteJson(l.state, { date: today(now), count })
}

// ---- writing proposals -------------------------------------------------------

function createProposalDir(l, base) {
  for (let n = 1; n < 10000; n++) {
    const id = n === 1 ? base : `${base}-${n}`
    const dir = join(l.proposed, id)
    try { mkdirSync(dir); return { id, dir } }
    catch (e) { if (e.code !== "EEXIST") throw e }
  }
  throw new Error("could not find a free proposal id")
}

/**
 * Write a proposal. Never overwrites: a name clash gets a numeric suffix.
 * @param {string} home
 * @param {{name:string, description:string, whenToUse:string, body:string}} skill
 * @param {object} meta  fields merged into meta.json (sessionId, turn, taskSummary, kind, target, targetPath, ...)
 * @returns {{id:string, dir:string, meta:object}}
 */
export function writeProposal(home, skill, meta, now = new Date(), max = Infinity) {
  const l = layout(home)
  if (!NAME_RE.test(skill.name)) throw new Error(`invalid skill name: ${skill.name}`)
  assertNoSymlink(l.proposed)
  mkdirSync(l.proposed, { recursive: true })
  assertNoSymlink(l.proposed)
  const isUpdate = meta.kind === "update"
  const count = reserveQuota(home, max, now)
  bumpQuota(home, count, now)
  const { id, dir } = createProposalDir(l, isUpdate ? `${skill.name}-update` : skill.name)
  // A suffixed *new* proposal gets a matching skill name; an update keeps the target's name.
  const finalSkill = isUpdate ? skill : { ...skill, name: id }
  writeFileSync(join(dir, "SKILL.md"), renderSkill(finalSkill))
  const full = {
    ...redactDeep(meta),
    id,
    skillName: finalSkill.name,
    kind: isUpdate ? "update" : "new",
    createdAt: now.toISOString(),
    taskSummary: redact(String(meta.taskSummary ?? "")).slice(0, 300),
  }
  atomicWriteJson(join(dir, "meta.json"), full)
  return { id, dir, meta: full }
}

// ---- reading ------------------------------------------------------------------

function assertId(id) {
  if (!ID_RE.test(String(id))) throw new Error(`invalid proposal id: ${id}`)
}

function readMeta(path, id) {
  assertNoSymlink(path)
  let meta
  try { meta = JSON.parse(readFileSync(path, "utf8")) }
  catch { throw new Error(`missing or malformed proposal metadata: ${id}`) }
  const valid = meta && typeof meta === "object" && !Array.isArray(meta)
    && meta.id === id && typeof meta.skillName === "string" && NAME_RE.test(meta.skillName)
    && (meta.kind === "new" && meta.skillName === id
      || meta.kind === "update" && (id === `${meta.skillName}-update` || new RegExp(`^${meta.skillName}-update-(?:[2-9]|[1-9][0-9]+)$`).test(id)))
  if (!valid) throw new Error(`invalid proposal metadata: ${id}`)
  return meta
}

export function listProposals(home) {
  const l = layout(home)
  if (!existsSync(l.proposed)) return []
  assertNoSymlink(l.proposed)
  return readdirSync(l.proposed, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => { try { return readMeta(join(l.proposed, e.name, "meta.json"), e.name) } catch { return undefined } })
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
}

export function readProposal(home, id) {
  assertId(id)
  const dir = join(layout(home).proposed, id)
  assertNoSymlink(dir)
  assertNoSymlink(join(dir, "SKILL.md"))
  assertNoSymlink(join(dir, "meta.json"))
  if (!existsSync(join(dir, "SKILL.md"))) throw new Error(`no such proposal: ${id}`)
  return {
    id,
    dir,
    meta: readMeta(join(dir, "meta.json"), id),
    content: readFileSync(join(dir, "SKILL.md"), "utf8"),
  }
}

// ---- diff -----------------------------------------------------------------------

/** Minimal LCS line diff in unified-like form. */
export function lineDiff(a, b, labelA = "a", labelB = "b") {
  if (a === b) return `--- ${labelA}\n+++ ${labelB}\n(no differences)`
  const x = a.split("\n")
  const y = b.split("\n")
  const n = x.length
  const m = y.length
  // shortcut: large inputs use a whole-file replacement, use a bounded diff algorithm if concise large diffs become necessary
  if ((n + 1) * (m + 1) > 1_000_000) return [`--- ${labelA}`, `+++ ${labelB}`, ...x.map((line) => `-${line}`), ...y.map((line) => `+${line}`)].join("\n")
  const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1])
  const out = [`--- ${labelA}`, `+++ ${labelB}`]
  let i = 0
  let j = 0
  let changed = false
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { out.push(` ${x[i]}`); i++; j++ }
    else if (j < m && (i >= n || t[i][j + 1] >= t[i + 1][j])) { out.push(`+${y[j]}`); j++; changed = true }
    else { out.push(`-${x[i]}`); i++; changed = true }
  }
  return changed ? out.join("\n") : `${out[0]}\n${out[1]}\n(no differences)`
}

/** Where an accepted proposal would be written. */
export function resolveDestination(home, proposal, { project, dest } = {}) {
  const l = layout(home)
  const name = proposal.meta.skillName ?? proposal.id
  if (!NAME_RE.test(name)) throw new Error(`invalid skill name in meta: ${name}`)
  if (dest) return { file: join(canonicalRoot(dest), name, "SKILL.md"), layout: "dir" }
  if (project) return { file: join(canonicalRoot(project), ".dsh", "skills", name, "SKILL.md"), layout: "dir" }
  return { file: join(l.skills, name, "SKILL.md"), layout: "dir" }
}

export function diffProposal(home, id, opts = {}) {
  const p = readProposal(home, id)
  const d = resolveDestination(home, p, opts)
  const label = p.meta.kind === "update" ? "current" : "existing"
  const source = !opts.project && !opts.dest && p.meta.kind === "update" && p.meta.targetPath
    ? p.meta.targetPath : d.file
  if (!existsSync(source)) return `(new skill: ${source} does not exist yet)\n`
  return lineDiff(readFileSync(source, "utf8"), p.content, `${label}: ${source}`, `proposed: ${join(p.dir, "SKILL.md")}`) + "\n"
}

// ---- accept / reject ------------------------------------------------------------------

function prepareArchive(l, kind) {
  const base = kind === "rejected" ? l.rejected : l.accepted
  assertNoSymlink(base)
  mkdirSync(base, { recursive: true })
  assertNoSymlink(base)
  return base
}

function archive(l, kind, id, patchMeta, now) {
  const base = prepareArchive(l, kind)
  let target = join(base, id)
  if (existsNoFollow(target)) {
    const stem = `${id}-${timestamp(now)}`
    target = join(base, stem)
    for (let n = 2; existsNoFollow(target); n++) target = join(base, `${stem}-${n}`)
  }
  renameSync(join(l.proposed, id), target)
  const metaPath = join(target, "meta.json")
  atomicWriteJson(metaPath, { ...readJson(metaPath, {}), ...patchMeta })
  return target
}

/**
 * Approve a proposal: write its SKILL.md to the destination (backing up any existing file as
 * `<file>.bak-<timestamp>`, which the skill scanner ignores) and archive the proposal.
 */
export function acceptProposal(home, id, opts = {}, now = new Date()) {
  const p = readProposal(home, id)
  const d = resolveDestination(home, p, opts)
  const parsed = parseFrontmatter(p.content)
  if (!parsed || !NAME_RE.test(String(parsed.data.name ?? ""))) throw new Error("proposal SKILL.md has no valid front matter; edit it first")
  if (parsed.data.name !== p.meta.skillName) throw new Error(`SKILL.md name "${parsed.data.name}" does not match proposal skill "${p.meta.skillName}"; edit it first`)
  const l = layout(home)
  prepareArchive(l, "accepted")
  assertNoSymlink(dirname(d.file))
  mkdirSync(dirname(d.file), { recursive: true })
  assertNoSymlink(d.file)
  let backup
  if (existsSync(d.file)) {
    const stem = `${d.file}.bak-${timestamp(now)}`
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? stem : `${stem}-${n}`
      try { copyFileSync(d.file, candidate, constants.COPYFILE_EXCL); backup = candidate; break }
      catch (e) { if (e.code !== "EEXIST") throw e }
    }
  }
  const temp = join(dirname(d.file), `.scribe-${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, p.content, { flag: "wx" })
    renameSync(temp, d.file)
  } finally {
    rmSync(temp, { force: true })
  }
  archive(l, "accepted", id, { acceptedAt: now.toISOString(), destination: d.file, ...(backup ? { backup } : {}) }, now)
  return { destination: d.file, backup }
}

export function rejectProposal(home, id, now = new Date()) {
  readProposal(home, id)
  const dir = archive(layout(home), "rejected", id, { rejectedAt: now.toISOString() }, now)
  return { dir }
}

export function dirSize(p) {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

export { rmSync }
