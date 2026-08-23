// The Supabase edge function. Deliberately thin: read environment into config, build the
// storage port, hand every request to the same router the tests drive over node:http.
//
// If this file ever grows a protocol decision, it is in the wrong place — the contract
// lives in relay/src, and a rule enforced here but not there would be a rule no other
// binding of this relay obeys.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { createRelayApp } from '../../../src/index.js'
import { createSupabaseStore } from '../../store.js'

function requireEnvironment(name) {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`missing required environment variable ${name}`)
  return value
}

function integerFrom(name) {
  const value = Number(requireEnvironment(name))
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`)
  return value
}

function listFrom(name) {
  const value = Deno.env.get(name)
  if (!value) return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

// Every number here comes from the environment. relay/AGENTS.md forbids these as literals
// in code, and the reason is federation: a threshold compiled in would become this
// relay's threshold for everyone who ever ran the code.
function readConfig() {
  const baselineDifficulty = {
    share: integerFrom('ELSEWEB_POW_DIFFICULTY_SHARE'),
    reply: integerFrom('ELSEWEB_POW_DIFFICULTY_REPLY'),
    vote: integerFrom('ELSEWEB_POW_DIFFICULTY_VOTE'),
  }
  const baselineQuota = {
    perKeyPerDay: integerFrom('ELSEWEB_QUOTA_PER_KEY_PER_DAY'),
    perKeyPerPagePerDay: integerFrom('ELSEWEB_QUOTA_PER_KEY_PER_PAGE_PER_DAY'),
    perKeyPerDayByKind: { vote: integerFrom('ELSEWEB_QUOTA_PER_KEY_PER_DAY_VOTE') },
  }
  const establishedAfterSeconds = integerFrom('ELSEWEB_TIER_ESTABLISHED_AFTER_SECONDS')

  return {
    protocolVersions: [1],
    kinds: ['share', 'reply', 'vote'],
    freshnessWindowSeconds: integerFrom('ELSEWEB_FRESHNESS_WINDOW_SECONDS'),
    maxPayloadBytes: integerFrom('ELSEWEB_MAX_PAYLOAD_BYTES'),
    quotaWindowSeconds: integerFrom('ELSEWEB_QUOTA_WINDOW_SECONDS'),
    pow: {
      maxDifficulty: integerFrom('ELSEWEB_POW_MAX_DIFFICULTY'),
      challengeRequired: false,
      // A new key sits in the lowest tier — small quota, high required work — and rises
      // with age and a clean record (relay/AGENTS.md, "Anti-flood").
      tiers: [
        { minAgeSeconds: 0, difficulty: baselineDifficulty, quota: baselineQuota },
        {
          minAgeSeconds: establishedAfterSeconds,
          difficulty: {
            share: integerFrom('ELSEWEB_POW_DIFFICULTY_SHARE_ESTABLISHED'),
            reply: integerFrom('ELSEWEB_POW_DIFFICULTY_REPLY_ESTABLISHED'),
            vote: integerFrom('ELSEWEB_POW_DIFFICULTY_VOTE_ESTABLISHED'),
          },
          quota: {
            perKeyPerDay: integerFrom('ELSEWEB_QUOTA_PER_KEY_PER_DAY_ESTABLISHED'),
            perKeyPerPagePerDay: integerFrom('ELSEWEB_QUOTA_PER_KEY_PER_PAGE_PER_DAY_ESTABLISHED'),
            perKeyPerDayByKind: {
              vote: integerFrom('ELSEWEB_QUOTA_PER_KEY_PER_DAY_VOTE_ESTABLISHED'),
            },
          },
        },
      ],
    },
    attestations: {
      requiredFor: listFrom('ELSEWEB_ATTESTATIONS_REQUIRED_FOR'),
      trustedIssuers: listFrom('ELSEWEB_TRUSTED_ISSUERS'),
      feedRequires: listFrom('ELSEWEB_FEED_REQUIRES'),
    },
    listing: {
      maxEvents: integerFrom('ELSEWEB_LISTING_MAX_EVENTS'),
      maxPerAuthor: integerFrom('ELSEWEB_LISTING_MAX_PER_AUTHOR'),
      candidatePoolSize: integerFrom('ELSEWEB_LISTING_CANDIDATE_POOL'),
    },
    feed: {
      maxEvents: integerFrom('ELSEWEB_FEED_MAX_EVENTS'),
      maxPerAuthor: integerFrom('ELSEWEB_FEED_MAX_PER_AUTHOR'),
      candidatePoolSize: integerFrom('ELSEWEB_FEED_CANDIDATE_POOL'),
    },
  }
}

// service_role never reaches a client: it is read from the function's environment, used
// to build this client, and never appears in a response body or a log line.
const supabase = createClient(
  requireEnvironment('SUPABASE_URL'),
  requireEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false } }
)

const app = createRelayApp({
  store: createSupabaseStore(supabase),
  config: readConfig(),
  clock: { now: () => Math.floor(Date.now() / 1000) },
})

Deno.serve((request) => app.handle(request))
