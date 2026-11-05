import assert from "node:assert/strict"
import { test } from "node:test"
import { makeDshLlm, makeHttpLlm } from "../src/llm.js"

test("LLM model and HTTP requests redact content at the send boundary", async () => {
  const envName = "SCRIBE_TEST_API_KEY"
  const old = process.env[envName]
  process.env[envName] = "synthetic[secret]78123"
  try {
    const secret = process.env[envName]
    const system = `system ${secret} Bearer abcdefgh123456`
    const user = `user ${secret} Bearer abcdefgh123456`
    const config = { timeoutMs: 1000, maxOutputTokens: 256 }
    let modelRequest
    const dsh = makeDshLlm(
      { llm: { stream: async function* (request) {
        modelRequest = request
        yield { type: "text-delta", index: 0, text: "ok" }
        yield { type: "finish", reason: { kind: "stop" } }
      } } },
      { id: "synthetic-session", requestContext: () => ({ provider: "p", model: "m" }) },
      config,
    )
    assert.equal(await dsh(system, user), "ok")
    for (const content of [modelRequest.system, modelRequest.messages[0].content[0].text]) {
      assert.ok(!content.includes(secret))
      assert.ok(!content.includes("abcdefgh123456"))
    }

    let httpRequest
    const http = makeHttpLlm(
      { baseURL: "http://localhost/v1", model: "m", apiKeyEnv: envName }, config, undefined,
      async (_url, request) => {
        httpRequest = request
        return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) }
      },
    )
    assert.equal(await http(system, user), "ok")
    const body = JSON.parse(httpRequest.body)
    for (const message of body.messages) {
      assert.ok(!message.content.includes(secret))
      assert.ok(!message.content.includes("abcdefgh123456"))
    }
    assert.equal(httpRequest.headers.authorization, `Bearer ${secret}`)
  } finally {
    if (old === undefined) delete process.env[envName]
    else process.env[envName] = old
  }
})

test("HTTP LLM errors on non-2xx, empty response, and parent abort", async () => {
  const config = { timeoutMs: 1000, maxOutputTokens: 256 }
  const endpoint = { baseURL: "http://localhost/v1", model: "m" }
  await assert.rejects(makeHttpLlm(endpoint, config, undefined, async () => ({ ok: false, status: 503 }))("s", "u"), /HTTP 503/)
  await assert.rejects(makeHttpLlm(endpoint, config, undefined, async () => ({ ok: true, json: async () => ({ choices: [] }) }))("s", "u"), /no text/)
  const parent = new AbortController()
  parent.abort()
  await assert.rejects(makeHttpLlm(endpoint, config, parent.signal, async () => { throw new Error("transport") })("s", "u"), /interrupted by dsh shutdown/)
})

test("HTTP send boundary masks short command and header secrets", async () => {
  let request
  const llm = makeHttpLlm(
    { baseURL: "http://localhost/v1", model: "m" },
    { timeoutMs: 1000, maxOutputTokens: 256 },
    undefined,
    async (_url, options) => {
      request = options
      return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) }
    },
  )
  await llm("Authorization: Basic dXNlcjpwYXNz", "curl --password short; sshpass -p'quote value' ssh -p 2222 host; pwd=small; passphrase: tiny; author: Jane Doe")
  const [system, user] = JSON.parse(request.body).messages.map((message) => message.content)
  assert.equal(system, "Authorization: [REDACTED]")
  assert.equal(user, "curl --password [REDACTED]; sshpass -p'[REDACTED]' ssh -p 2222 host; pwd=[REDACTED]; passphrase: [REDACTED]; author: Jane Doe")
})

test("HTTP send boundary masks escaped quoted credentials", async () => {
  let request
  const llm = makeHttpLlm(
    { baseURL: "http://localhost/v1", model: "m" },
    { timeoutMs: 1000, maxOutputTokens: 256 },
    undefined,
    async (_url, options) => {
      request = options
      return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) }
    },
  )
  await llm("system", 'password: "hun\\"ter2"; db_pwd=hunter2')
  const user = JSON.parse(request.body).messages[1].content
  assert.equal(user, 'password: "[REDACTED]"; db_pwd=[REDACTED]')
})

test("HTTP send boundary masks multiline quoted credentials", async () => {
  let request
  const llm = makeHttpLlm(
    { baseURL: "http://localhost/v1", model: "m" },
    { timeoutMs: 1000, maxOutputTokens: 256 },
    undefined,
    async (_url, options) => {
      request = options
      return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) }
    },
  )
  await llm("system", 'password: "a\nb"; mysql -p"x\ny" db; ssh -p 2222 host')
  assert.equal(JSON.parse(request.body).messages[1].content,
    'password: "[REDACTED]"; mysql -p"[REDACTED]" db; ssh -p 2222 host')
})
