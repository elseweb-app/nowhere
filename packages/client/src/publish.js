// Publish orchestration for the relay pool (SPEC.md sections 7, 12 and 16). Split out of
// pool.js because everything that happens between "here is a draft" and "every relay has
// an answer" — policy fan-out, kind/version prechecks, size and freshness, proof-of-work
// escalation — is one concern on its own; pool.js should stay about which relays a client
// holds, this about what happens when it writes to them.

import { mine, signEvent, isFresh } from '@elseweb/protocol'
import { actionForRejectionCode } from './relay.js'
import { ElsewebError, actionForCode } from './errors.js'
import { estimateEncodedBytes } from './events.js'

function clampToPolicyMax(difficulty, policy) {
  const max = policy.pow?.max_difficulty
  return typeof max === 'number' ? Math.min(difficulty, max) : difficulty
}

function maxDifficultyAcross(policies, kind) {
  return policies.reduce(
    (max, policy) =>
      Math.max(max, clampToPolicyMax(policy.pow?.default_difficulty?.[kind] ?? 0, policy)),
    0
  )
}

// The tightest of the relays' own limits, so one event satisfies all of them
// (SPEC.md section 12, "Disagreement"). A relay silent on a field imposes no bound.
function tightestAcross(policies, field) {
  const declared = policies
    .map((policy) => policy[field])
    .filter((value) => typeof value === 'number')
  return declared.length > 0 ? Math.min(...declared) : Infinity
}

// Fetches every writable relay's policy without letting one broken relay abort the
// broadcast to the healthy ones. A relay whose policy cannot be fetched is excluded from
// mining and submission, and reported back as RELAY_UNREACHABLE rather than thrown.
async function resolvePolicies(targets) {
  const settled = await Promise.all(
    targets.map(async (relay) => {
      try {
        return { relay, policy: await relay.getPolicy() }
      } catch (cause) {
        return {
          relay,
          failure: {
            relay: relay.url,
            ok: false,
            code: 'RELAY_UNREACHABLE',
            message: `policy could not be fetched from ${relay.url}: ${String(cause?.message ?? cause)}`,
            action: actionForCode('RELAY_UNREACHABLE'),
          },
        }
      }
    })
  )
  return {
    reachable: settled.filter((entry) => entry.policy !== undefined),
    excluded: settled.filter((entry) => entry.failure !== undefined).map((entry) => entry.failure),
  }
}

// Mining for a relay that will never accept the kind or the version is wasted work, so
// this runs before any mining starts rather than being discovered from a rejection.
function partitionBySupport(reachable, event) {
  const supported = []
  const excluded = []
  for (const { relay, policy } of reachable) {
    if (!policy.protocol_versions.includes(event.v)) {
      excluded.push({
        relay: relay.url,
        ok: false,
        code: 'UNSUPPORTED_VERSION',
        message: `${relay.url} does not support protocol version ${event.v}`,
        action: actionForRejectionCode('UNSUPPORTED_VERSION'),
        protocol_versions: policy.protocol_versions,
      })
      continue
    }
    if (!policy.kinds.includes(event.kind)) {
      excluded.push({
        relay: relay.url,
        ok: false,
        code: 'UNSUPPORTED_KIND',
        message: `${relay.url} does not accept kind "${event.kind}"`,
        action: actionForRejectionCode('UNSUPPORTED_KIND'),
        kinds: policy.kinds,
      })
      continue
    }
    supported.push({ relay, policy })
  }
  return { supported, excluded }
}

async function mineAndSign({ draft, privateKey, difficulty, miningOptions }) {
  const unsigned = { ...draft, nonce: 0 }
  const minedCandidate = await mine(unsigned, difficulty, miningOptions)
  return signEvent(minedCandidate, privateKey)
}

// Mines once at the highest difficulty any in-scope writable relay requires, then
// submits the identical signed event to every one of them. Outcomes are returned per
// relay and never collapsed into one boolean (SPEC.md section 12).
export async function publishToRelays({ targets, event, privateKey, miningOptions, clock }) {
  if (targets.length === 0) {
    throw new Error('relay pool has no writable relay to publish to')
  }

  const { reachable, excluded: unreachable } = await resolvePolicies(targets)
  const { supported, excluded: unsupported } = partitionBySupport(reachable, event)
  const excludedResults = [...unreachable, ...unsupported]

  if (supported.length === 0) {
    return { event: null, results: excludedResults }
  }

  const policies = supported.map((entry) => entry.policy)
  const difficulty = maxDifficultyAcross(policies, event.kind)
  const payloadLimit = tightestAcross(policies, 'max_payload_bytes')
  const freshnessWindow = tightestAcross(policies, 'freshness_window_seconds')

  const estimatedBytes = estimateEncodedBytes(event)
  if (estimatedBytes > payloadLimit) {
    throw new ElsewebError(
      'PAYLOAD_TOO_LARGE',
      `event of an estimated ${estimatedBytes} bytes exceeds the tightest relay limit of ${payloadLimit} bytes`,
      { max_payload_bytes: payloadLimit }
    )
  }

  let draft = event
  let mined = await mineAndSign({ draft, privateKey, difficulty, miningOptions })

  // Mining can outlast the freshness window it started inside (SPEC.md sections 7.2 and
  // 7.4): a long search at high difficulty can push `created_at` outside every relay's
  // window before the event is ever submitted, which would make every relay reject it as
  // STALE_TIMESTAMP for a reason mining itself caused. Checked once, against the
  // tightest window in scope, and re-mined at most once with a fresh timestamp.
  if (!isFresh(mined.created_at, { now: clock.now(), windowSeconds: freshnessWindow })) {
    draft = { ...event, created_at: clock.now() }
    mined = await mineAndSign({ draft, privateKey, difficulty, miningOptions })
  }

  const targetRelays = supported.map((entry) => entry.relay)
  const results = await Promise.all(targetRelays.map((relay) => relay.publish(mined)))

  const insufficient = results
    .map((result, index) => ({ result, relay: targetRelays[index], policy: policies[index] }))
    .filter(({ result }) => !result.ok && result.code === 'POW_INSUFFICIENT')

  if (insufficient.length === 0) {
    return { event: mined, results: [...results, ...excludedResults] }
  }

  // POW_INSUFFICIENT gets exactly one re-mine, at the highest difficulty actually
  // demanded — clamped to each demanding relay's own advertised ceiling, since a relay
  // can never legitimately need more than the cap it published — resubmitted only to
  // the relays that asked for more.
  const retryDifficulty = insufficient.reduce(
    (max, { result, policy }) =>
      Math.max(max, clampToPolicyMax(result.required_difficulty ?? difficulty, policy)),
    difficulty
  )
  const remined = await mineAndSign({
    draft,
    privateKey,
    difficulty: retryDifficulty,
    miningOptions,
  })
  const retryResults = await Promise.all(insufficient.map(({ relay }) => relay.publish(remined)))

  const retryResultByRelay = new Map(
    insufficient.map(({ relay }, index) => [relay, retryResults[index]])
  )
  const finalResults = results.map(
    (result, index) => retryResultByRelay.get(targetRelays[index]) ?? result
  )

  return { event: remined, results: [...finalResults, ...excludedResults], remined }
}
