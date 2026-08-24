// One shared local-AI provider implementation, per the task brief: Ollama, LM Studio
// and a generic custom endpoint all speak (a subset of) the OpenAI-compatible HTTP API
// — `/v1/models` and `/v1/chat/completions` — so this is provider-preset data
// (src/providers/presets.js), not provider-specific code. Nothing here knows the word
// "Ollama"; that only lives in presets.js and the UI that offers it as a shortcut.
//
// `fetch` is injected, matching packages/client's discipline, so this module is
// testable with a stub and never assumes a global.

function endpointFor(baseUrl, path) {
  return baseUrl.endsWith('/') ? `${baseUrl.slice(0, -1)}${path}` : `${baseUrl}${path}`
}

async function safeJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

// Runs `fetchImplementation` bounded by `signal` if the caller gave one (typically the
// worker's own execution-timeout signal — see src/worker/job-runner.js), or by its own
// internal timer otherwise, for a standalone probe/testModel call with no job attached.
async function withTimeout(signal, timeoutMs, run) {
  if (signal) return run(signal)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

export function createLocalAIProvider({ baseUrl, fetch: fetchImplementation, apiKey }) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new TypeError('createLocalAIProvider requires a baseUrl')
  }
  if (typeof fetchImplementation !== 'function') {
    throw new TypeError('createLocalAIProvider requires an injected fetch implementation')
  }

  const authHeaders = apiKey ? { authorization: `Bearer ${apiKey}` } : {}

  // Probing is a cheap reachability check only — it MUST NOT be treated as proof a
  // model can actually generate; see testModel() for that.
  async function probe({ timeoutMs = 3000 } = {}) {
    try {
      const response = await withTimeout(undefined, timeoutMs, (signal) =>
        fetchImplementation(endpointFor(baseUrl, '/v1/models'), { headers: authHeaders, signal })
      )
      return { ok: response.ok, status: response.status }
    } catch (cause) {
      return { ok: false, status: 0, message: String(cause?.message ?? cause) }
    }
  }

  async function listModels({ timeoutMs = 5000 } = {}) {
    try {
      const response = await withTimeout(undefined, timeoutMs, (signal) =>
        fetchImplementation(endpointFor(baseUrl, '/v1/models'), { headers: authHeaders, signal })
      )
      if (!response.ok) return { ok: false, models: [] }
      const body = await safeJson(response)
      const models = Array.isArray(body?.data) ? body.data.map((entry) => entry.id) : []
      return { ok: true, models }
    } catch (cause) {
      return { ok: false, models: [], message: String(cause?.message ?? cause) }
    }
  }

  async function generateText({
    model,
    messages,
    maxTokens,
    temperature,
    timeoutMs = 60000,
    signal,
  }) {
    try {
      const response = await withTimeout(signal, timeoutMs, (effectiveSignal) =>
        fetchImplementation(endpointFor(baseUrl, '/v1/chat/completions'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders },
          body: JSON.stringify({
            model,
            messages,
            max_tokens: maxTokens,
            temperature,
            stream: false,
          }),
          signal: effectiveSignal,
        })
      )
      if (!response.ok) {
        const body = await safeJson(response)
        return {
          ok: false,
          message: body?.error?.message ?? `local provider returned HTTP ${response.status}`,
        }
      }
      const body = await safeJson(response)
      const text = body?.choices?.[0]?.message?.content ?? ''
      const usage = body?.usage ?? {}
      return {
        ok: true,
        text,
        usage: {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
        },
      }
    } catch (cause) {
      const timedOut = cause?.name === 'AbortError'
      return {
        ok: false,
        message: timedOut ? 'generation timed out' : String(cause?.message ?? cause),
      }
    }
  }

  // A model "existing" in listModels() is not the same as it actually working — a
  // partially-downloaded or misconfigured model can list but fail to generate. This is
  // the one real generation the UI runs before a model can be marked allowed.
  async function testModel(model, { timeoutMs = 20000 } = {}) {
    const result = await generateText({
      model,
      messages: [{ role: 'user', content: 'Reply with the single word "ok".' }],
      maxTokens: 8,
      timeoutMs,
    })
    return result.ok
      ? { ok: true, message: 'model responded' }
      : { ok: false, message: result.message }
  }

  return { baseUrl, probe, listModels, generateText, testModel }
}
