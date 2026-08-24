// Admission/abuse limits (root AGENTS.md's "Admission / abuse protection"): every one
// of these is checked, in this order, before a request ever reaches a local model.
// Locally configurable, with safe defaults — never hardcoded past what a user can
// change in Options.

export const DEFAULT_LIMITS = {
  maxConcurrentJobs: 1,
  maxInputBytes: 8_000,
  maxOutputTokens: 512,
  executionTimeoutMs: 60_000,
}

const SUPPORTED_CAPABILITIES = ['text.generate', 'code.generate']

function byteLength(text) {
  return new TextEncoder().encode(text).length
}

// `request` is the JSON payload the requester sends over the opened DataChannel —
// never anything the relay itself parses. Checked in the order root AGENTS.md lists:
// requester/job structure, capability, work-proof/admission (already enforced by the
// relay before claim — see relay/AGENTS.md), request size, output limit, timeout,
// concurrency.
export function checkAdmission({ request, capability, allowedModels, limits, activeJobCount }) {
  if (!request || typeof request !== 'object') {
    return { ok: false, reason: 'malformed_request' }
  }
  if (typeof request.model !== 'string' || typeof request.prompt !== 'string') {
    return { ok: false, reason: 'malformed_request' }
  }
  if (!SUPPORTED_CAPABILITIES.includes(capability)) {
    return { ok: false, reason: 'unsupported_capability' }
  }
  if (!allowedModels.includes(request.model)) {
    return { ok: false, reason: 'model_not_allowed' }
  }
  if (byteLength(request.prompt) > limits.maxInputBytes) {
    return { ok: false, reason: 'input_too_large' }
  }
  const requestedMaxTokens = Number.isInteger(request.maxTokens)
    ? request.maxTokens
    : limits.maxOutputTokens
  if (requestedMaxTokens > limits.maxOutputTokens) {
    return { ok: false, reason: 'output_limit_exceeded' }
  }
  if (activeJobCount >= limits.maxConcurrentJobs) {
    return { ok: false, reason: 'concurrency_limit_reached' }
  }
  return { ok: true, maxTokens: Math.min(requestedMaxTokens, limits.maxOutputTokens) }
}
