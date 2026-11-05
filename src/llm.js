// LLM access. Preferred: dsh's own model layer (ctx.llm.stream), same pattern as
// dsh-session-title-llm. Fallback: a configured OpenAI-compatible endpoint.

// Loaded once at module load so that starting a draft needs no I/O turn: in a
// one-shot `dsh --json` run the process tears services down right after the
// turn ends, so the model call has to be dispatched immediately.
import { redact } from "./redact.js"

let dshLlm
try {
  dshLlm = await import("@deepseek-ai/dsh-llm")
} catch {
  dshLlm = undefined
}

/** Combine the shutdown signal with a per-call timeout. */
function callSignal(parentSignal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout
}

/** Build an `llm(system, user)` function backed by ctx.llm. */
export function makeDshLlm(ctx, session, config, parentSignal) {
  if (!dshLlm) throw new Error("@deepseek-ai/dsh-llm is not resolvable")
  const { BlockAssembler, createUserMessage } = dshLlm
  const route = config.model ?? session.requestContext?.()
  if (!route?.provider || !route?.model) throw new Error("no model route: configure `model` or let the session log a route first")
  return async (system, user) => {
    const signal = callSignal(parentSignal, config.timeoutMs)
    try {
      const messages = [
        createUserMessage({ content: [{ type: "text", text: redact(user) }], source: { kind: "dsh-skill-scribe" } }),
      ]
      const assembler = new BlockAssembler()
      for await (const chunk of ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        messages,
        system: redact(system),
        maxTokens: config.maxOutputTokens,
        sessionId: session.id,
        signal,
      })) {
        signal.throwIfAborted()
        assembler.push(chunk)
      }
      signal.throwIfAborted()
      const fin = assembler.finish
      if (fin?.kind === "error" || fin?.kind === "aborted") throw new Error(fin.failure?.message ?? "LLM call failed")
      const text = assembler
        .blocks()
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
      if (!text.trim()) throw new Error(fin?.kind === "max-tokens" ? "LLM hit maxOutputTokens before any answer" : "LLM returned no text")
      return text
    } catch (e) {
      if (parentSignal?.aborted) throw new Error("interrupted by dsh shutdown")
      throw e
    }
  }
}

/** Build an `llm(system, user)` function that calls an OpenAI-compatible chat endpoint. */
export function makeHttpLlm(endpoint, config, parentSignal, fetchImpl = globalThis.fetch) {
  return async (system, user) => {
    const key = endpoint.apiKeyEnv ? process.env[endpoint.apiKeyEnv] : undefined
    try {
      const res = await fetchImpl(`${endpoint.baseURL.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({
          model: endpoint.model,
          messages: [
            { role: "system", content: redact(system) },
            { role: "user", content: redact(user) },
          ],
          max_tokens: config.maxOutputTokens,
          temperature: 0.2,
        }),
        signal: callSignal(parentSignal, config.timeoutMs),
      })
      if (!res.ok) throw new Error(`endpoint HTTP ${res.status}`)
      const json = await res.json()
      const text = json?.choices?.[0]?.message?.content
      if (typeof text !== "string" || !text.trim()) throw new Error("endpoint returned no text")
      return text
    } catch (e) {
      if (parentSignal?.aborted) throw new Error("interrupted by dsh shutdown")
      throw e
    }
  }
}

/**
 * Pick the LLM path: dsh model layer first; the configured endpoint when dsh's is
 * unavailable or fails.
 */
export function makeLlm(ctx, session, config, signal) {
  let primary
  try {
    primary = makeDshLlm(ctx, session, config, signal)
  } catch (e) {
    if (!config.endpoint) throw e
  }
  if (!primary) return makeHttpLlm(config.endpoint, config, signal)
  if (!config.endpoint) return primary
  const secondary = makeHttpLlm(config.endpoint, config, signal)
  return async (system, user) => {
    try {
      return await primary(system, user)
    } catch (e) {
      if (signal?.aborted) throw e
      return secondary(system, user)
    }
  }
}
