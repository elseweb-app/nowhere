import { describe, it, expect, vi } from 'vitest'
import { createLocalAIProvider } from '../src/providers/openai-compatible.js'

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body
    },
  }
}

describe('createLocalAIProvider construction', () => {
  it('requires a baseUrl', () => {
    expect(() => createLocalAIProvider({ fetch: vi.fn() })).toThrow()
  })
  it('requires an injected fetch implementation', () => {
    expect(() => createLocalAIProvider({ baseUrl: 'http://localhost:11434' })).toThrow()
  })
})

describe('probe', () => {
  it('reports reachable when /v1/models responds ok', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ data: [] }))
    const provider = createLocalAIProvider({ baseUrl: 'http://localhost:11434', fetch: fetchSpy })
    expect((await provider.probe()).ok).toBe(true)
  })

  it('reports unreachable rather than throwing on a network failure', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('connection refused')
    })
    const provider = createLocalAIProvider({ baseUrl: 'http://localhost:11434', fetch: fetchSpy })
    const result = await provider.probe()
    expect(result.ok).toBe(false)
  })
})

describe('listModels', () => {
  it('maps the OpenAI-compatible model list shape shared by Ollama, LM Studio and a generic endpoint', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'qwen3:8b' }, { id: 'llama3' }] })
    )
    const provider = createLocalAIProvider({ baseUrl: 'http://localhost:11434', fetch: fetchSpy })
    const result = await provider.listModels()
    expect(result.ok).toBe(true)
    expect(result.models).toEqual(['qwen3:8b', 'llama3'])
  })
})

describe('generateText', () => {
  it('sends a chat-completions request and extracts text and usage', async () => {
    let capturedBody = null
    const fetchSpy = vi.fn(async (url, options) => {
      capturedBody = JSON.parse(options.body)
      return jsonResponse({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      })
    })
    const provider = createLocalAIProvider({ baseUrl: 'http://localhost:11434', fetch: fetchSpy })

    const result = await provider.generateText({
      model: 'qwen3:8b',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 8,
    })

    expect(result.ok).toBe(true)
    expect(result.text).toBe('ok')
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 1 })
    expect(capturedBody.model).toBe('qwen3:8b')
    expect(capturedBody.stream).toBe(false)
  })

  it('turns an abort into a typed timeout outcome rather than throwing', async () => {
    const fetchSpy = vi.fn(
      (url, options) =>
        new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
    )
    const provider = createLocalAIProvider({ baseUrl: 'http://localhost:11434', fetch: fetchSpy })

    const result = await provider.generateText({
      model: 'qwen3:8b',
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 10,
    })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/timed out/)
  })
})

describe('testModel', () => {
  it('reports success when generation succeeds', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'ok' } }] }))
    const provider = createLocalAIProvider({ baseUrl: 'http://localhost:11434', fetch: fetchSpy })
    expect((await provider.testModel('qwen3:8b')).ok).toBe(true)
  })

  it('reports failure with the provider message when generation fails', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ error: { message: 'model not loaded' } }, { status: 500 })
    )
    const provider = createLocalAIProvider({ baseUrl: 'http://localhost:11434', fetch: fetchSpy })
    const result = await provider.testModel('qwen3:8b')
    expect(result.ok).toBe(false)
    expect(result.message).toBe('model not loaded')
  })
})
