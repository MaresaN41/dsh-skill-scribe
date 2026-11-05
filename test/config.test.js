import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULTS, resolveConfig } from "../src/config.js"

test("accepts the schema's integer boundary values", () => {
  const c = resolveConfig({
    minToolCalls: 1,
    maxProposalsPerDay: 0,
    timeoutMs: 1000,
    maxOutputTokens: 256,
    shutdownGraceMs: 0,
  })
  assert.deepEqual(
    [c.minToolCalls, c.maxProposalsPerDay, c.timeoutMs, c.maxOutputTokens, c.shutdownGraceMs],
    [1, 0, 1000, 256, 0],
  )
  assert.equal(resolveConfig({ shutdownGraceMs: 4500 }).shutdownGraceMs, 4500)
})

test("uses defaults for out-of-range integers", () => {
  const c = resolveConfig({
    minToolCalls: 0,
    maxProposalsPerDay: -1,
    timeoutMs: 999,
    maxOutputTokens: 255,
    shutdownGraceMs: 4501,
  })
  assert.deepEqual(
    [c.minToolCalls, c.maxProposalsPerDay, c.timeoutMs, c.maxOutputTokens, c.shutdownGraceMs],
    [DEFAULTS.minToolCalls, DEFAULTS.maxProposalsPerDay, DEFAULTS.timeoutMs, DEFAULTS.maxOutputTokens, DEFAULTS.shutdownGraceMs],
  )
})

test("uses defaults for non-integers and non-number values", () => {
  const c = resolveConfig({
    minToolCalls: 1.5,
    maxProposalsPerDay: "2",
    timeoutMs: 1000.5,
    shutdownGraceMs: 50,
    maxOutputTokens: "256",
    shutdownGraceMs: -0.5,
  })
  assert.deepEqual(
    [c.minToolCalls, c.maxProposalsPerDay, c.timeoutMs, c.maxOutputTokens, c.shutdownGraceMs],
    [DEFAULTS.minToolCalls, DEFAULTS.maxProposalsPerDay, DEFAULTS.timeoutMs, DEFAULTS.maxOutputTokens, DEFAULTS.shutdownGraceMs],
  )
})


test("enforces schema steps for timeout and shutdown grace", () => {
  const c = resolveConfig({ timeoutMs: 1500, shutdownGraceMs: 50 })
  assert.equal(c.timeoutMs, DEFAULTS.timeoutMs)
  assert.equal(c.shutdownGraceMs, DEFAULTS.shutdownGraceMs)
})
