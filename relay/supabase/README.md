# Supabase binding

One binding of the relay core in `relay/src/`, not the relay itself. The core knows
nothing about Supabase; this directory maps its storage port onto Postgres and its router
onto a Deno edge function. Swapping this out for another host is the whole point — see
"Running your own relay" in `../AGENTS.md`.

## Layout

| Path | Role |
|---|---|
| `functions/relay/index.js` | Deno entry: reads env into config, hands requests to the core's router |
| `store.js` | The storage port over Postgres |
| `migrations/*.sql` | Forward-only schema. Never edit an applied migration — add a new one |

## Required environment variables

Documented by name only; real values never appear in this repo.

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side database access. **Only ever inside the function environment** — never in client code, never in a build artifact |

**Verification limits**

| Variable | Purpose |
|---|---|
| `ELSEWEB_FRESHNESS_WINDOW_SECONDS` | How far `created_at` may be from server time, in either direction |
| `ELSEWEB_MAX_PAYLOAD_BYTES` | Encoded event size cap |
| `ELSEWEB_POW_MAX_DIFFICULTY` | Ceiling advertised in the policy document |

**Tiers.** A new key sits in the lowest tier; it reaches the second after
`ELSEWEB_TIER_ESTABLISHED_AFTER_SECONDS` with a clean record, and any abuse report holds
it at the lowest regardless of age.

| Variable | Purpose |
|---|---|
| `ELSEWEB_TIER_ESTABLISHED_AFTER_SECONDS` | Age at which a clean key reaches the second tier |
| `ELSEWEB_POW_DIFFICULTY_SHARE` / `_REPLY` / `_VOTE` | Required difficulty for an unknown key, per kind |
| `ELSEWEB_POW_DIFFICULTY_SHARE_ESTABLISHED` / `_REPLY_ESTABLISHED` / `_VOTE_ESTABLISHED` | The same, once established |
| `ELSEWEB_QUOTA_WINDOW_SECONDS` | The window quotas are counted over |
| `ELSEWEB_QUOTA_PER_KEY_PER_DAY` | Per-key cap, lowest tier |
| `ELSEWEB_QUOTA_PER_KEY_PER_PAGE_PER_DAY` | Per-(key, page) cap, lowest tier — the bound that actually stops a flood |
| `ELSEWEB_QUOTA_PER_KEY_PER_DAY_VOTE` | Per-key vote cap, lowest tier |
| `ELSEWEB_QUOTA_PER_KEY_PER_DAY_ESTABLISHED` / `_PER_PAGE_PER_DAY_ESTABLISHED` / `_VOTE_ESTABLISHED` | The same three, once established |

**Attestations and listings**

| Variable | Purpose |
|---|---|
| `ELSEWEB_TRUSTED_ISSUERS` | Comma-separated hex pubkeys this relay trusts. Empty trusts nobody |
| `ELSEWEB_ATTESTATIONS_REQUIRED_FOR` | Comma-separated kinds that require an attestation to publish |
| `ELSEWEB_FEED_REQUIRES` | Comma-separated claims an event must carry to appear in this relay's feed |
| `ELSEWEB_LISTING_MAX_EVENTS` / `_MAX_PER_AUTHOR` / `_CANDIDATE_POOL` | Bounds and author diversity for page and vote queries |
| `ELSEWEB_FEED_MAX_EVENTS` / `_MAX_PER_AUTHOR` / `_CANDIDATE_POOL` | The same for the feed, which page-scoping does not constrain at all |

Every threshold is configuration. `relay/AGENTS.md` forbids these as literals in code, and
the reason is federation: a number baked into the core would make it this relay's number
for everyone who ran the code.

The issuer signing key is deliberately absent from this list. The membership issuer is not
part of this phase; when it arrives its key is held exactly as `SUPABASE_SERVICE_ROLE_KEY`
is, because whoever holds it can mint memberships.

## Verification

Per `../AGENTS.md`, run the function against a local Supabase instance and confirm:

1. A valid payload is stored and returned by a later fetch for the same page identity.
2. An invalid payload is rejected without a partial write.
3. RLS actually blocks a write it should block — test with the **anon** key, not
   `service_role`, which bypasses RLS by design and would prove nothing.

`relay/test/e2e.test.js` proves the same flow against the in-memory store, with no
Supabase and no Docker. That test covers the core; this checklist covers the binding.
