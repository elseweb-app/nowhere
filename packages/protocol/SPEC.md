# everywhere.app relay protocol — v1 (draft)

Normative specification of the wire contract between a client and a relay.

This document is the source of truth for the federation contract. Anything published on
everywhere.app describing the relay standard is derived from this file, and the two are
updated in the same pull request.

**Implementing the endpoints in §10 is sufficient to run a relay.** Nothing in this
document depends on Supabase, on our reference implementation in `relay/`, or on
everywhere.app being involved at all.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used in the RFC 2119 sense.

---

## 1. Scope and design principle

The protocol defines **mechanisms, not policy.**

It contains no numeric thresholds — no proof-of-work difficulty, no quota, no tier
definition, no price. Those are each relay's own configuration. What the protocol defines
is the structure that makes a policy expressible, discoverable, and actionable by a
client: the event envelope, the policy document (§11), and the rejection codes (§16).

Two consequences that govern the whole design:

- A relay MUST be free to be stricter or looser than any other relay without breaking
  clients.
- **No participant is privileged by the protocol.** everywhere.app's own relay is a relay
  like any other; its feed policy is expressed with the same mechanisms available to
  everyone, and a different client can make different choices (§13).

## 2. Cryptographic primitives

| Purpose | Algorithm |
|---|---|
| Signature | Ed25519 |
| Hash | SHA-256 |
| Key derivation (key transfer only) | PBKDF2-HMAC-SHA256 |
| Symmetric cipher (key transfer only) | AES-256-GCM |
| Binary encoding | Lowercase hexadecimal |

All of these are reachable through WebCrypto in every runtime we target — extension, web,
and Capacitor-wrapped mobile — so a conforming client needs no cryptography dependency.

`pubkey` is a 32-byte Ed25519 public key, hex-encoded (64 characters).
`sig` is a 64-byte signature, hex-encoded (128 characters).
`id` is a 32-byte SHA-256 digest, hex-encoded (64 characters).

**Private keys MUST be generated as extractable.** A user must be able to move their
identity between devices (§15). A key that cannot leave the runtime that created it
strands its owner permanently, and the mistake is unfixable after the fact: keys already
issued to users cannot be retroactively made extractable.

## 3. Canonical serialization

Signatures and proof-of-work are computed over the same byte sequence. If two
implementations serialize the same event differently, signatures fail to verify and the
cause is very hard to find. Canonicalization is therefore normative.

- The canonical form is **JSON Canonicalization Scheme, RFC 8785** (JCS): object keys
  sorted by UTF-16 code unit, no insignificant whitespace, UTF-8 output.
- The canonical form covers every field of the event **except `id` and `sig`**, which are
  omitted entirely (not set to `null`).
- Optional fields that are absent MUST be omitted, never serialized as `null`. A field
  present with `null` and a field absent are different canonical forms, and therefore
  different events.
- **All numbers MUST be integers.** No floating point value appears anywhere, which
  removes RFC 8785's number-formatting edge cases entirely.
- Canonicalization MUST NOT alter string content. Clients SHOULD apply Unicode NFC
  normalization to human-entered text *before* constructing the event, so that the same
  visible text produces the same bytes.

Then:

```
canonical_bytes = JCS(event without id and sig)
id              = hex(SHA-256(canonical_bytes))
sig             = hex(Ed25519-Sign(privkey, SHA-256(canonical_bytes)))
```

Implementations MUST ship test vectors: hand-written events with their expected canonical
bytes, `id`, and `sig`. Anyone writing a second relay validates against these.

## 4. The event envelope

Every object on the network is an **event**. Sharing, replying and voting differ only in
`kind` and in the kind-specific fields.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | integer | yes | Protocol version. `1` for this document |
| `kind` | string | yes | `"share"`, `"reply"` or `"vote"` (§5) |
| `pubkey` | hex string | yes | Author's Ed25519 public key |
| `created_at` | integer | yes | Unix seconds. Binds freshness (§7.2) |
| `identity_mode` | `"persistent"` \| `"ephemeral"` | yes | See §9 |
| `nonce` | integer | yes | Varied during mining (§7.1) |
| `attestations` | array | yes | Publicly verifiable claims about `pubkey` (§8). MAY be empty |
| `page_id` | hex string | by kind | Normalized page identity (§6) |
| `parent_id` | hex string | by kind | Direct parent event |
| `root_id` | hex string | by kind | Thread root event |
| `target_id` | hex string | by kind | Event being voted on |
| `content` | object | yes | Kind-specific payload |
| `id` | hex string | yes | Per §3. Not part of the canonical form |
| `sig` | hex string | yes | Per §3. Not part of the canonical form |

Schemas are a discriminated union on `kind`. A field not required by a kind MUST be
absent, not present-and-empty.

A relay MUST verify, in this order, and MUST reject on the first failure:

1. `v` is a protocol version the relay speaks — otherwise `UNSUPPORTED_VERSION`;
2. `kind` is a kind the relay accepts — otherwise `UNSUPPORTED_KIND`;
3. the event matches the schema for its kind — otherwise `SCHEMA_INVALID`;
4. the encoded size is within the relay's limit — otherwise `PAYLOAD_TOO_LARGE`;
5. `created_at` is inside the freshness window — otherwise `STALE_TIMESTAMP`;
6. `id` equals the hash of the recomputed canonical bytes — otherwise `SCHEMA_INVALID`;
7. `sig` verifies against `pubkey` — otherwise `SIGNATURE_INVALID`;
8. every attestation verifies and is unexpired — otherwise `ATTESTATION_INVALID`;
9. the relay's attestation requirements are met — otherwise `ATTESTATION_REQUIRED`;
10. `id` carries sufficient work — otherwise `POW_INSUFFICIENT`;
11. the author is within quota — otherwise `QUOTA_EXCEEDED`.

Version and kind are checked first so a relay never rejects an event it simply does not
understand with a code claiming the event was malformed. Signature and proof-of-work are
checked before any quota lookup, so an unauthenticated caller cannot cause database work.

## 5. Event kinds

### 5.1 `share`

Requires `page_id`. `content` carries the shared material.

### 5.2 `reply`

Requires `parent_id`, `root_id`, and `page_id`.

- `parent_id` is the event replied to, which MAY itself be a reply.
- `root_id` is the `share` at the top of the thread, so a whole thread is one query.
- `page_id` is denormalized from the root, so a page query returns the thread with it.

A relay MAY cap thread depth and MAY reject a reply whose parent it does not hold.
A client MUST render a reply whose parent is missing as an orphan rather than dropping
it — in a federation the parent may live on a relay the reader does not use.

### 5.3 `vote`

Requires `target_id`. `content` is `{ "value": 1 }` or `{ "value": -1 }`.

- At most one vote per `(pubkey, target_id)` is effective. A later `created_at` replaces
  an earlier one; on equal `created_at` the lexicographically greater `id` wins. This tie
  rule is normative so that independent relays converge on the same result.
- A relay MUST expose aggregate counts and MUST also serve the underlying vote events, so
  a client can recount and detect a relay that misreports. An aggregate nobody can audit
  is an aggregate a relay can invent.
- Clients MUST NOT rank by raw vote count. Votes are the cheapest event to mass-produce
  and therefore the highest-leverage target for a Sybil attack; weight them by voter tier
  and attestations (§14).

## 6. Page identity

`page_id` is an opaque hex string derived from the page's URL by this package's
normalization function. Two users on the same page MUST derive the same `page_id`, or
they cannot see each other — the product's core correctness requirement.

The derivation rules are specified separately in this package and are **part of the
protocol**. Changing them changes which users can see each other, which partitions the
network. A change to normalization is a breaking protocol change and requires a version
bump.

A relay MUST treat `page_id` as opaque. It MUST NOT re-derive, rewrite, or interpret it.

## 7. Proof of work

### 7.1 Definition

Difficulty is the number of leading zero **bits** of the `id` digest. A client mines by
varying `nonce` and recomputing `id` until the required difficulty is met.

Verification is stateless: counting leading zero bits of a value the relay already
computed. A relay can verify work from an author it has never seen, which is what makes
this usable across a federation.

Proof-of-work MUST NOT be required on read paths.

### 7.2 Freshness — why the window exists

Without a freshness constraint, proof-of-work accomplishes nothing: an attacker mines
events offline for months and releases them at once. The stockpile *is* the flood.

Because `created_at` is inside the canonical bytes, it is committed to by `id` and
therefore by the work. A relay MUST reject an event whose `created_at` lies outside its
advertised freshness window, in either direction. Pre-computed work is then worth at most
one window.

Clients SHOULD mine immediately before submitting, and MUST NOT retain a mined event
beyond the window and resubmit it.

A relay MAY additionally require its own rotating challenge value. This is optional by
design: a relay-specific challenge makes one mined event valid at one relay only, which
defeats the multi-relay broadcast in §12.

### 7.3 Adaptive difficulty

Required difficulty MAY vary per author and per kind — high for an unknown key, low or
zero for an established one; a `vote` is a smaller action than a `share` and MAY cost
differently. Discovery:

- `GET /policy` (§11) advertises what an **unknown** key must pay, per kind.
- `GET /keys/{pubkey}` (§10) returns what that key currently must pay.
- A `POW_INSUFFICIENT` rejection carries `required_difficulty`, so a client that guessed
  low recovers in a single retry.

### 7.4 Client obligations

Mining MUST be cancellable and MUST report progress. A client MUST stop at a bounded
effort and surface a clear error rather than appearing to hang.

## 8. Attestations

An attestation is a publicly verifiable claim about `pubkey`, carried by the event. It is
how a client or relay distinguishes an account someone invested in from one generated a
second ago.

An attestation MUST be verifiable by any third party holding only public information. A
claim nobody outside the issuing relay can check is not an attestation; it is that
relay's private database, and it does not belong on the wire.

### 8.1 `issuer-signed`

```json
{
  "type": "issuer-signed",
  "issuer": "<hex pubkey of the issuer>",
  "claim": "membership",
  "subject": "<hex pubkey being attested>",
  "issued_at": 0,
  "expires_at": 0,
  "sig": "<issuer signature over the canonical attestation without sig>"
}
```

- `subject` MUST equal the event's `pubkey`.
- A verifier checks `sig` against `issuer`, then checks `expires_at` against now. Nothing
  else is required — no call to the issuer, no shared secret.
- Whether an issuer is *trusted* is not a protocol question. Each client and relay keeps
  its own trusted-issuer list (§13).

**An attestation states membership, not identity.** It MUST NOT carry a name, an email
address, a payment reference, or any other personal data. Whatever the issuer did to
decide the claim — a payment, an invitation, a manual review — stays entirely off the
network.

**Revocation is by expiry.** Attestations SHOULD be short-lived and reissued while the
underlying condition holds, so that a refund, a chargeback, or an abuse finding takes
effect by simply not reissuing. An issuer MAY additionally publish a revocation list; a
verifier MUST NOT depend on being able to reach one.

### 8.2 `host-account` — reserved

Reserved for v2: proving control of an account on the host site by publishing the key's
fingerprint in a profile bio or public post, at `proof_url`, verifiable by anyone. Its
effect is that a Sybil identity costs whatever an account on that platform costs.

Clients MUST tolerate attestation types they do not recognize by ignoring them, so new
types do not require a version bump.

## 9. Identity modes

- **`persistent`** — the default. Reputation accrues to this key; key age, quota tiers and
  attestations are built on it.
- **`ephemeral`** — a single-use key. Relays SHOULD apply their lowest quota; clients
  SHOULD rank it lowest.

An ephemeral key cannot hold an attestation, since an attestation binds to a subject key
that must persist to be worth issuing. Ephemeral events therefore never appear in an
attestation-gated feed (§13) — this follows from the design rather than being enforced.

**A relay cannot distinguish an `ephemeral` key from a newly created persistent one.** The
field is an honest client's declaration, not a security control. An attacker who omits it
is simply treated as a new key, which is already the lowest tier. No security property may
depend on this field.

Users MUST be told that a persistent key lets a relay link all of their events together.

## 10. Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/policy` | Policy document (§11) |
| `GET` | `/keys/{pubkey}` | Required difficulty and remaining quota for one key |
| `POST` | `/events` | Publish one event (§4) |
| `GET` | `/events?page_id=…` | Events for one page, including its threads |
| `GET` | `/events?target_id=…` | Vote events for one target, for independent recount |
| `GET` | `/feed?cursor=…` | The relay's feed (§13) |

Every listing endpoint MUST return results already bounded and diversified: a single
`pubkey` MUST NOT be able to occupy an unbounded portion of one response. Clients apply
their own limits on top (§14); neither side relies on the other.

## 11. Policy document

`GET /policy` returns the relay's machine-readable policy. A client reads it and adapts;
this is the only way one client works against relays with different rules.

```json
{
  "protocol_versions": [1],
  "kinds": ["share", "reply", "vote"],
  "pow": {
    "default_difficulty": { "share": 20, "reply": 18, "vote": 14 },
    "max_difficulty": 24,
    "challenge_required": false
  },
  "freshness_window_seconds": 300,
  "max_payload_bytes": 8192,
  "attestations": {
    "required_for": [],
    "trusted_issuers": ["<hex pubkey>"],
    "feed_requires": ["membership"]
  },
  "quotas": {
    "per_key_per_day": 50,
    "per_key_per_page_per_day": 5,
    "per_key_per_day_by_kind": { "vote": 200 }
  }
}
```

Values are illustrative. A client MUST NOT hardcode any of them, and MUST NOT assume a
field's value when the field is absent.

## 12. Multi-relay clients

A client holds a **set** of relays, editable by the user at any time, each marked readable
and/or writable, with its policy document cached. Single-relay operation is the degenerate
case of a set of one; it is not a separate code path.

**Publishing.** A client mines once at the highest difficulty required by its writable
relays, then submits the same event to each. Per-relay outcomes MUST be surfaced
individually — a relay that rejected while others accepted is not a silent partial
success. If a relay requires its own challenge (§7.2), that event is valid only there and
MUST be mined separately.

**Reading.** A client queries its readable relays and merges. Because `id` is a content
hash, the same event arriving from several relays deduplicates for free. A client SHOULD
record which relays carried an event: presence on many independent relays is a weak
positive signal, and it is what makes relay outages invisible to the reader.

**Disagreement.** Where relays advertise different limits, a client MUST apply the
tightest when constructing an event to broadcast. An `ATTESTATION_REQUIRED` from one relay
is shown to the user, not retried blindly.

**Changing relays MUST NOT affect identity.** The keypair is the identity; a relay is a
place events are kept. Removing every relay and adding new ones loses no identity and
requires no migration.

## 13. Feeds

`GET /feed` is a relay's own curated stream, distinct from the page-scoped queries that
drive the in-page experience.

A feed is an ordinary query plus a filter. The protocol defines no privileged feed and no
privileged relay:

- A relay declares in `policy.attestations.feed_requires` which claims an event must carry
  to appear in its feed.
- A client keeps its own trusted-issuer list and MAY filter further, or ignore the relay's
  filter and build its own view from page queries.

This is how an attestation-gated feed and an open one coexist without either being
special. everywhere.app's own relay gates its feed on a `membership` claim from its
issuer; a different client, pointed at a different relay or configured with a different
trusted-issuer list, produces a different feed from the same protocol.

Feeds are the one surface where the network's page-scoping does **not** bound abuse: a
page query is naturally narrow, a feed is not. Per-`(pubkey, page_id)` quotas do not
constrain a feed. A relay serving a feed MUST therefore apply its own author diversity and
volume bounds, independently of any page-level limit.

## 14. Client rendering obligations

A flood only succeeds if it is displayed. A conforming client:

- MUST NOT render events in raw chronological order;
- MUST cap how many events are rendered per page and per feed screen;
- MUST enforce author diversity, so one `pubkey` cannot dominate a view;
- MUST weight votes by voter standing rather than counting them raw (§5.3);
- SHOULD rank using attestations, key tier and age, engagement, and recency, so that an
  unknown key with no attestation and no engagement sorts to the bottom.

## 15. Key transfer between devices

A user moves one identity between the extension, the website, and the mobile app. The
transfer carries the 32-byte Ed25519 seed inside an encrypted envelope, displayed as a QR
code on the source device and scanned by the target.

```json
{
  "v": 1,
  "type": "key-transfer",
  "kdf": { "name": "PBKDF2-HMAC-SHA256", "salt": "<hex>", "iterations": 600000 },
  "cipher": { "name": "AES-256-GCM", "iv": "<hex>" },
  "ciphertext": "<hex>",
  "expires_at": 0
}
```

- The envelope is decrypted with a **transfer code** shown on the source device and typed
  on the target — never encoded in the QR.
- The transfer code MUST be generated by the client, MUST NOT be chosen by the user, and
  MUST carry at least 60 bits of entropy. A short numeric PIN is not acceptable here: a
  photograph of the QR is enough to attack the envelope offline, at leisure, where an
  expiry timestamp gives no protection at all. Entropy is the only thing defending a
  captured envelope.
- `expires_at` bounds how long a target device will accept the envelope. It defends
  against a stale QR being reused; it does not defend against offline cracking.
- The QR MUST be displayed only while transfer is in progress, and the source device
  SHOULD warn that anyone who captures both the code and the QR gains the identity
  permanently — a key cannot be rotated without losing its accrued standing.

Transfer works in either direction. Nothing about it involves a relay: a private key MUST
NOT be transmitted to any server, encrypted or not.

## 16. Rejection codes

Every rejection carries a stable code so a client knows what to do. A bare `400` is not
conformant: a client that cannot tell the cases apart will either retry forever or give up
on a recoverable error.

```json
{ "error": { "code": "POW_INSUFFICIENT", "message": "…", "required_difficulty": 22 } }
```

| Code | Extra fields | Client action |
|---|---|---|
| `UNSUPPORTED_VERSION` | `protocol_versions` | Do not retry |
| `UNSUPPORTED_KIND` | `kinds` | Do not retry on this relay |
| `SCHEMA_INVALID` | `field` | Bug. Do not retry |
| `PAYLOAD_TOO_LARGE` | `max_payload_bytes` | Shrink content, re-mine |
| `STALE_TIMESTAMP` | `server_time`, `freshness_window_seconds` | Correct clock skew, re-mine |
| `SIGNATURE_INVALID` | — | Bug. Do not retry |
| `ATTESTATION_INVALID` | `reason` | Refresh the attestation, then retry |
| `ATTESTATION_REQUIRED` | `required_claims`, `trusted_issuers` | Surface to the user. Do not retry |
| `POW_INSUFFICIENT` | `required_difficulty` | Re-mine at the stated difficulty |
| `QUOTA_EXCEEDED` | `retry_after` | Wait. Do not re-mine |

---

# Appendix A — threat model and rationale (non-normative)

Recorded here so a later reader does not have to rediscover it.

## A.1 The reframing

Key generation cannot be prevented. Generating an Ed25519 keypair is generating a random
number; if it could be restricted, someone would have to control who may generate one, and
the network would not be federated. So the design does not try:

> Creating a key stays free. Making a key **visible** is what costs.

## A.2 Where page-scoping helps, and where it stops

In-page views are naturally narrow: an attacker cannot flood "the network", only a page,
and the damage is bounded by what that page renders. This is why quotas are enforced per
`(pubkey, page_id)`. It is the cheapest win in the design.

**Feeds remove that protection.** A feed is cross-page by definition, so per-page quotas
do not constrain it and a global stream is exactly the surface page-scoping denied an
attacker. Feeds therefore carry their own bounds, and the attestation gate below exists
mainly because of them.

## A.3 Attestation-gated feeds and what payment actually buys

everywhere.app gates its own feed on a paid membership claim. Payment is the strongest
Sybil resistance available to us: it is costly, hard to automate at volume, and it borrows
the fraud tooling of the payment network.

It is not absolute, and the design does not treat it as such:

- A one-off fee prices a Sybil fleet linearly — a thousand identities is a thousand times
  a small number, which a motivated attacker will pay. A recurring membership changes the
  economics far more than the amount does.
- Stolen payment instruments make the attacker's cost zero. Chargebacks and refunds MUST
  drop membership, which is why attestations expire and are reissued rather than granted
  once (§8.1).
- Accounts are resellable. Payment raises the floor; it does not remove the need for
  quotas, proof-of-work, ranking and diversity underneath it.

The structural point matters more than the amount: because membership is an
**issuer-signed attestation** rather than a private list on our relay, the protocol stays
neutral. Our feed is a filter anyone can express, other issuers can exist, and a community
client can choose a different trusted-issuer list — including none — and get an open feed
from the same network. Had we made the feed a privilege of our own relay, everywhere.app
would be a federated protocol with a centralized product bolted through it.

## A.4 Attacks named, and what answers them

| Attack | Answer |
|---|---|
| Loop that generates keys and posts | Proof-of-work per event (§7) |
| Months of offline pre-mining, released at once | Freshness window binds work to `created_at` (§7.2) |
| Key farm aged in advance to reach a high tier | Turns a five-minute attack into a weeks-long investment; caught by quotas and ranking |
| Flooding one page from many fresh keys | Per-`(pubkey, page_id)` quota, render cap, diversity (§10, §14) |
| Flooding the feed | Attestation gate (§8, §13), plus feed-specific bounds |
| Vote brigading from fresh keys | Votes weighted by standing, never counted raw (§5.3) |
| Relay inventing vote totals | Raw vote events are served for independent recount (§5.3) |
| Hiding the `ephemeral` flag | Nothing depends on the flag; an unflagged new key is already lowest tier (§9) |
| Photographing a transfer QR | Envelope encrypted under a high-entropy client-generated code, never a short PIN (§15) |

## A.5 Rejected alternatives

- **Feed gated by a private list on our relay.** Same product outcome, but it makes our
  relay structurally privileged and unverifiable by anyone else. Replaced by issuer-signed
  attestations, which are checkable by any third party.
- **Aggregate-only vote counts.** Cheaper and more private, but a relay could fabricate
  totals with no way for anyone to notice. Raw vote events stay available.
- **Invite-gated writes.** Very effective, and abuse is prunable up the invite tree, but it
  closes the network at its edges. Remains available as a relay-level policy.
- **Relay-specific rotating challenge as a requirement.** Fully defeats pre-mining, but
  binds a mined event to one relay and breaks multi-relay broadcast. Left optional.
- **Per-site key rotation.** Better privacy, but reputation restarts everywhere and both
  the tier mechanism and attestations collapse. `ephemeral` mode is the release valve.
- **Non-extractable keys.** Better key hygiene in the browser, and fatal to device
  transfer. Rejected before any key exists, because it cannot be undone afterwards.

## A.6 Three things to be honest about

1. **This does not solve Sybil.** It is economics, not cryptography: raise the cost of an
   attack above its value, and make the flood invisible even when a write succeeds. Any
   design claiming to *prevent* Sybil in a permissionless network is wrong.
2. **Reputation and privacy are in direct conflict.** A persistent key is what lets
   reputation accrue, and it is also what lets a relay link every event to one person. That
   cost was chosen deliberately and must be stated to users, not quietly imposed.
3. **A paid feed splits the network in two.** There is an attested surface and an open one,
   and most users will only ever see the first. Keeping the open one genuinely usable is a
   continuing choice, not something the protocol guarantees on its own.
