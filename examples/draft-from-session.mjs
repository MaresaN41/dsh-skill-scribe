#!/usr/bin/env node
// Draft proposals from an already-recorded session log, using an OpenAI-compatible
// endpoint. Useful to backfill proposals, or to re-draft a turn skipped when
// the plugin's model call was interrupted (for example in a one-shot `dsh
// --json` run, where dsh tears down within ~5 s of the turn ending).
//
//   zstd -dc $DSH_HOME/sessions/<dir>/<session>/session.v4.jsonl.zstd > session.jsonl
//   node examples/draft-from-session.mjs session.jsonl --base-url http://127.0.0.1:8081/v1 --model qwen3.5-4b
//
// The proposal lands in $DSH_HOME/skill-scribe/proposed/ like any other.

import { readFileSync } from "node:fs"
import { resolveConfig, resolveHome } from "../src/config.js"
import { TurnCollector } from "../src/gate.js"
import { makeHttpLlm } from "../src/llm.js"
import { processTurn } from "../src/scribe.js"

const argv = process.argv.slice(2)
const opt = (flag, d) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : d)
const file = argv[0]?.startsWith("--") ? undefined : argv[0]
if (!file) {
  console.error("usage: draft-from-session.mjs <session.jsonl> --base-url <url> --model <id> [--api-key-env ENV] [--language ja]")
  process.exit(2)
}

const config = resolveConfig({
  language: opt("--language", "auto"),
  endpoint: { baseURL: opt("--base-url", "http://127.0.0.1:8081/v1"), model: opt("--model", "qwen3.5-4b"), apiKeyEnv: opt("--api-key-env") },
})
const home = resolveHome(config)
const llm = makeHttpLlm(config.endpoint, config)

const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
const header = JSON.parse(lines[0])
const collector = new TurnCollector()
for (const line of lines.slice(1)) {
  const event = JSON.parse(line)
  const summary = collector.feed(header.id, event)
  if (!summary) continue
  const res = await processTurn({ home, config, summary, llm })
  console.log(`turn ${summary.turn}:`, JSON.stringify(res))
}
