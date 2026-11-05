#!/usr/bin/env node
import { execute } from "../src/cli.js"
import { resolveHome } from "../src/config.js"

const { code, text } = execute(process.argv.slice(2), { home: resolveHome() })
;(code === 0 ? process.stdout : process.stderr).write(`${text}\n`)
process.exitCode = code
