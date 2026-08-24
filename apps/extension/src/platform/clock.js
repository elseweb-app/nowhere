// The clock port every packages/client module expects: now() in Unix seconds, matching
// every timestamp in packages/protocol.

export function createSystemClock() {
  return { now: () => Math.floor(Date.now() / 1000) }
}
