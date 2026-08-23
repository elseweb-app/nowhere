// Web Worker entry point for mining off the main/UI thread.
//
// This is the one file in packages/client allowed to touch Worker globals (`self`,
// `postMessage`) — see packages/client/AGENTS.md and root AGENTS.md section 5. Every
// other module in this package stays platform-free; this file is exempt only because
// it IS the worker's entry point rather than code the rest of the package runs inside.
// The host app supplies the worker factory (e.g. `new Worker(new URL('./pow-worker.js',
// import.meta.url), { type: 'module' })`), so nothing else here knows workers exist.

import { createMiner } from './pow.js'
import { isElsewebError } from './errors.js'

self.onmessage = async (messageEvent) => {
  const { event, difficulty } = messageEvent.data
  const miner = createMiner({
    onProgress: (progress) => self.postMessage({ type: 'progress', ...progress }),
  })

  try {
    const minedEvent = await miner.mine(event, difficulty)
    self.postMessage({ type: 'result', event: minedEvent })
  } catch (error) {
    if (isElsewebError(error)) {
      self.postMessage({ type: 'error', code: error.code, message: error.message })
      return
    }
    self.postMessage({ type: 'error', code: 'UNKNOWN', message: error.message })
  }
}
