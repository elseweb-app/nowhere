// Mining orchestration over protocol's mine() — SPEC.md §7.4 requires mining to be
// cancellable, to report progress, and to give up at a bounded effort rather than
// appear to hang. protocol's mine() already implements all three; this module only
// translates its outcomes into ElsewebError so every consumer of this package catches
// one error type instead of a DOMException here and a plain Error there.

import { mine } from '@elseweb/protocol'
import { ElsewebError } from './errors.js'

export function createMiner({ maxIterations, onProgress } = {}) {
  async function runMine(event, difficulty, { signal } = {}) {
    try {
      return await mine(event, difficulty, { signal, maxIterations, onProgress })
    } catch (error) {
      throw translateMiningError(error)
    }
  }

  return { mine: runMine }
}

// protocol's mine() (packages/protocol/src/pow.js) has exactly two failure modes: an
// AbortError DOMException when the caller's signal fires, and a plain Error when
// maxIterations is exceeded without reaching the required difficulty. There is no
// third path, so anything that is not an AbortError is the exhaustion case.
function translateMiningError(error) {
  if (error?.name === 'AbortError') {
    return new ElsewebError('MINING_ABORTED', 'mining was cancelled before finishing', {
      cause: error,
    })
  }
  return new ElsewebError('MINING_EXHAUSTED', error.message, { cause: error })
}
