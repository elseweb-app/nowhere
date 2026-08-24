import { describe, it, expect } from 'vitest'
import { checkAdmission, DEFAULT_LIMITS } from '../src/worker/limits.js'

const baseArgs = {
  capability: 'text.generate',
  allowedModels: ['qwen3:8b'],
  limits: DEFAULT_LIMITS,
  activeJobCount: 0,
}

describe('checkAdmission', () => {
  it('admits a well-formed request within every limit', () => {
    const result = checkAdmission({
      ...baseArgs,
      request: { model: 'qwen3:8b', prompt: 'hello' },
    })
    expect(result.ok).toBe(true)
    expect(result.maxTokens).toBe(DEFAULT_LIMITS.maxOutputTokens)
  })

  it('rejects a malformed request', () => {
    expect(checkAdmission({ ...baseArgs, request: null }).reason).toBe('malformed_request')
    expect(checkAdmission({ ...baseArgs, request: { model: 'qwen3:8b' } }).reason).toBe(
      'malformed_request'
    )
  })

  it('rejects an unsupported capability', () => {
    const result = checkAdmission({
      ...baseArgs,
      capability: 'image.generate',
      request: { model: 'qwen3:8b', prompt: 'hi' },
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('unsupported_capability')
  })

  it('rejects a model that is not in the allowed list', () => {
    const result = checkAdmission({
      ...baseArgs,
      request: { model: 'some-other-model', prompt: 'hi' },
    })
    expect(result.reason).toBe('model_not_allowed')
  })

  it('rejects a prompt larger than maxInputBytes', () => {
    const result = checkAdmission({
      ...baseArgs,
      limits: { ...DEFAULT_LIMITS, maxInputBytes: 4 },
      request: { model: 'qwen3:8b', prompt: 'this is way too long' },
    })
    expect(result.reason).toBe('input_too_large')
  })

  it('rejects a requested maxTokens above the configured output limit', () => {
    const result = checkAdmission({
      ...baseArgs,
      request: { model: 'qwen3:8b', prompt: 'hi', maxTokens: 10_000 },
    })
    expect(result.reason).toBe('output_limit_exceeded')
  })

  it('clamps an unspecified maxTokens to the configured limit', () => {
    const result = checkAdmission({
      ...baseArgs,
      limits: { ...DEFAULT_LIMITS, maxOutputTokens: 64 },
      request: { model: 'qwen3:8b', prompt: 'hi' },
    })
    expect(result.ok).toBe(true)
    expect(result.maxTokens).toBe(64)
  })

  it('rejects a job once the concurrency limit is reached', () => {
    const result = checkAdmission({
      ...baseArgs,
      activeJobCount: 1,
      limits: { ...DEFAULT_LIMITS, maxConcurrentJobs: 1 },
      request: { model: 'qwen3:8b', prompt: 'hi' },
    })
    expect(result.reason).toBe('concurrency_limit_reached')
  })
})
