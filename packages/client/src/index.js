// The facade most consumers need, plus every piece it is assembled from. A host that
// wants something different — the extension driving mining from a worker, a relay
// explorer that never publishes — composes the parts instead of forking the facade.

export { createElsewebClient } from './client.js'

export { createRelay, actionForRejectionCode } from './relay.js'
export { createDiscovery } from './discovery.js'
export { createRelayPool } from './pool.js'
export { createKeyStore } from './keys.js'
export { createReader } from './read.js'
export { createMiner } from './pow.js'

export { buildShare, buildReply, buildVote, estimateEncodedBytes } from './events.js'
export { verifyEventAttestations, trustedAttestations } from './attestations.js'
export { deriveStanding } from './standing.js'
export { isAuthentic, keepAuthentic } from './authenticity.js'
export { assembleThreads } from './thread.js'
export { tallyVotes, rankEvents } from './ranking.js'
export { ElsewebError, isElsewebError, actionForCode } from './errors.js'
