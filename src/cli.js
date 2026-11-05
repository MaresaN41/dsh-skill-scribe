// Command grammar shared by `bin/scribe.js` and the in-dsh `/scribe` command.

import { acceptProposal, diffProposal, layout, listProposals, readProposal, rejectProposal } from "./store.js"
import { existsSync, realpathSync } from "node:fs"
import { resolve } from "node:path"

export const USAGE = [
  "usage: scribe <command> [options]",
  "  list                          list pending proposals",
  "  show <id>                     print a proposal (meta + SKILL.md)",
  "  diff <id> [--project <dir>] [--dest <skills-dir>]",
  "                                updates compare with source unless a destination is selected",
  "  accept <id> [--project <dir>] [--dest <skills-dir>]",
  "                                install into $DSH_HOME/skills by default; update source stays unchanged",
  "  reject <id>                   move it to rejected/ (never deleted)",
].join("\n")

/** Split a command line into words, honouring simple single/double quotes. */
export function splitArgs(line) {
  const out = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

function takeOption(args, flag) {
  const i = args.indexOf(flag)
  if (i < 0) return undefined
  const v = args[i + 1]
  if (v === undefined) throw new Error(`${flag} needs a value`)
  args.splice(i, 2)
  return v
}

/**
 * Execute one scribe command.
 * @param {string[]} argv words after the program name
 * @param {{home:string}} env
 * @returns {{code:number, text:string}}
 */
export function execute(argv, { home }) {
  const args = [...argv]
  const cmd = args.shift()
  try {
    switch (cmd) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        return { code: cmd === undefined ? 1 : 0, text: USAGE }
      case "list": {
        const items = listProposals(home)
        if (items.length === 0) return { code: 0, text: "no pending proposals" }
        const rows = items.map(
          (m) => `${m.id}\t${m.kind}${m.kind === "update" ? `->${m.target}` : ""}\t${m.createdAt}\t${m.drafter ?? "?"}\t${m.taskSummary ?? ""}`.slice(0, 200),
        )
        return { code: 0, text: ["id\tkind\tcreated\tdrafter\ttask", ...rows].join("\n") }
      }
      case "show": {
        const id = need(args, "show <id>")
        const p = readProposal(home, id)
        return { code: 0, text: `${JSON.stringify(p.meta, null, 2)}\n\n${p.content}` }
      }
      case "diff": {
        const project = takeOption(args, "--project")
        const dest = takeOption(args, "--dest")
        return { code: 0, text: diffProposal(home, need(args, "diff <id>"), { project, dest }) }
      }
      case "accept": {
        const project = takeOption(args, "--project")
        const dest = takeOption(args, "--dest")
        const id = need(args, "accept <id>")
        const source = readProposal(home, id).meta.targetPath
        const r = acceptProposal(home, id, { project, dest })
        const physical = (path) => existsSync(path) ? realpathSync(path) : resolve(path)
        const unchangedSource = source && physical(source) !== physical(r.destination)
          ? `\nsource: ${source} (unchanged)` : ""
        return { code: 0, text: `accepted ${id} -> ${r.destination}${unchangedSource}${r.backup ? `\nbackup: ${r.backup}` : ""}` }
      }
      case "reject": {
        const id = need(args, "reject <id>")
        const r = rejectProposal(home, id)
        return { code: 0, text: `rejected ${id} -> ${r.dir}` }
      }
      default:
        return { code: 2, text: `unknown command: ${cmd}\n${USAGE}` }
    }
  } catch (e) {
    return { code: 1, text: `error: ${e?.message ?? e}` }
  }
}

function need(args, usage) {
  const v = args.shift()
  if (!v) throw new Error(`missing argument: ${usage}`)
  if (args.length) throw new Error(`unexpected argument: ${args[0]}`)
  return v
}

export { layout }
