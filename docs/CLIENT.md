# Building on ElseWeb without the extension

`@elseweb-app/client` is the whole ElseWeb client. The browser extension is one host of it —
not a prerequisite. Anything that can run JavaScript and make an HTTP request can join
the network: a SvelteKit page, a Node script, a mobile WebView, a relay explorer, a bot.
This document is that path, in depth.

If you just need the option table and the API surface, `packages/client/README.md` is
the quick reference and stays accurate. This document goes underneath it: why the shapes
are what they are, and worked examples copied from what the test suite actually runs.

Where anything here disagrees with `packages/protocol/SPEC.md`, the spec wins. This is a
narrative document about one implementation of it.

---

## 1. What the client does for you

A relay speaks a small, strict HTTP contract (SPEC.md sections 4–16): canonical byte
encoding, content-addressed ids, proof-of-work, Ed25519 signatures, a policy document per
relay, typed rejection codes. None of that is product logic, and all of it has to be
gotten exactly right or two honest clients silently stop agreeing with each other. That
is what `@elseweb-app/client` owns, so that a consumer only ever supplies product data:

- **URL normalization and target derivation** — turning whatever URL a user is looking at
  into the `page_id`/`page_url`/`anchor` triple two independent users converge on
  (`@elseweb/protocol`'s `deriveTarget`, SPEC.md §6).
- **Policy discovery** — fetching and caching each relay's `/policy`, so mining and
  payload checks happen against real, current numbers instead of guesses.
- **Proof-of-work** — mining the event to whatever difficulty the writable relay set
  actually requires, cancellably, with progress, bounded.
- **Canonical serialization, hashing and signing** — building `id` and `sig` exactly the
  way SPEC.md §3–4 defines, so a relay you didn't write still accepts the bytes.
- **Multi-relay publication** — one mining pass, submitted identically to every writable
  relay, with per-relay results kept separate rather than collapsed.
- **Response validation** — every event a relay hands back is schema-checked
  (`safeParseEvent`), signature-checked (`verifyEvent`), and checked that its `page_id`
  really is `hash(page_url)` before it is allowed anywhere near your UI. A relay is
  untrusted input; this is where that stops being your problem.
- **Merge and dedupe** — the same event arriving from three relays becomes one item,
  because `id` is a content hash and merging needs no coordination.
- **Ranking and threading** — turning a flat, deduplicated event list into ordered shares
  with replies hung off them, so three different hosts (extension, website, mobile) order
  content identically.

What is left for you to supply: the storage port, the UI, and the text people write.

## 2. Install and instantiate

`@elseweb/protocol` is `"private": true` — it never has its own registry entry, because
esbuild bundles it straight into `@elseweb-app/client`'s `dist/index.js`. The client
package itself is public, published to GitHub Packages, not npmjs.com.

Two ways to actually depend on it:

- **From inside this workspace.** Any package added under `apps/*`, `packages/*` or
  `relay/` and listed in `pnpm-workspace.yaml` gets `@elseweb-app/client` via
  `"@elseweb-app/client": "workspace:*"` in its `package.json`, resolved by pnpm's workspace
  linking — no registry involved. This is how `relay/test/e2e.test.js` consumes it.
- **From an external project**, via `npm install @elseweb-app/client` or
  `pnpm add @elseweb-app/client` — but only after pointing your package manager at
  GitHub's registry for the `@elseweb-app` scope and supplying a token with
  `read:packages`, since **GitHub Packages requires an authenticated install even for a
  public package**. `packages/client/README.md`'s "Install from outside this workspace"
  section has the exact `.npmrc` and the one-time token setup; this document does not
  repeat it.

Once resolved, the shape is what the README shows:

```js
import { createElsewebClient } from '@elseweb-app/client'

const client = createElsewebClient({
  relays: ['https://relay.example.com'],
  identityStore: myStorageImplementation,
})
```

`relays` and `identityStore` are the only two things a consumer must decide before
anything else works. Everything else in the options object — `clock`, `fetch`,
`trustedIssuers`, `canonicalizeUrl`, `limit`, `onPowProgress`, `miningOptions` — has a
default or is optional, and each is covered in its own section below.

## 3. The storage port

`packages/client/AGENTS.md` states the constraint plainly: this package has no DOM, no
`chrome.*`, no `localStorage`. The one thing every host runtime — an MV3 service worker,
a SvelteKit page, a Capacitor WebView — actually has in common is `fetch` and `Promise`,
not a storage API. So storage is a **port**: three methods, injected, and that is the
entire contract `createKeyStore` (`packages/client/src/keys.js`) requires:

```js
const identityStore = {
  get: (key) => Promise<value | undefined>,
  set: (key, value) => Promise<void>,
  remove: (key) => Promise<void>,
}
```

`createKeyStore` throws a `TypeError` immediately if `storage.get` is not a function —
this is checked at construction, not discovered the first time someone tries to publish.

There is exactly one key ever stored, under `'elseweb.identity'`, holding the whole
identity record including the private key. A consumer never manages that key name or
shape directly; it only has to make `get`/`set`/`remove` work for whatever the client
hands it.

**Browser (IndexedDB)** — copy-pasteable from `packages/client/README.md`:

```js
const DATABASE_NAME = 'elseweb'
const STORE_NAME = 'identity'

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transact(mode, run) {
  return openDatabase().then(
    (database) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode)
        const request = run(transaction.objectStore(STORE_NAME))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
  )
}

export const browserIdentityStore = {
  get: (key) => transact('readonly', (store) => store.get(key)),
  set: (key, value) => transact('readwrite', (store) => store.put(value, key)),
  remove: (key) => transact('readwrite', (store) => store.delete(key)),
}
```

**Node or an in-memory test double** — this is literally what
`relay/test/e2e.test.js` uses to prove the client works over a real socket, and what the
package's own tests use too (`packages/client/test/helpers.js`'s `createFakeStorage`):

```js
function createMemoryIdentityStore() {
  const values = new Map()
  return {
    async get(key) {
      return values.get(key)
    },
    async set(key, value) {
      values.set(key, value)
    },
    async remove(key) {
      values.delete(key)
    },
  }
}
```

This is why the same package can sit inside `apps/extension` (backed by
`chrome.storage.local`), a web app (backed by IndexedDB), or a Capacitor mobile app
(backed by Capacitor Preferences), without a single `if (chrome)` branch anywhere in
`packages/client`. The port is the platform boundary; everything on the client side of
it is the same code, always.

## 4. Identity

There is no email, no password, no hosted account. Identity is an Ed25519 keypair
generated on the device, and the client's job is narrower than "manage login": it is
"never let the private key leave this closure except through one deliberate, encrypted
path."

```js
await client.identity.get() // { publicKey, identityMode, createdAt } | null
await client.identity.getOrCreate() // the common startup call
await client.identity.create() // a deliberate fresh key ("start over")
await client.identity.clear()
```

`identity.get()` and `identity.getOrCreate()` **never return a private key.** Look at
`publicIdentity()` in `packages/client/src/client.js`:

```js
function publicIdentity(record) {
  if (!record) return null
  return {
    publicKey: record.publicKey,
    identityMode: record.identityMode,
    createdAt: record.createdAt,
  }
}
```

The stored record does hold `privateKey` (that is what `createKeyStore` writes through
your storage port), but every path back out to a consumer is filtered through this
function. The seed lives in the closure formed by `createElsewebClient` and the storage
port it was given; it leaves that closure exactly once, through `identity.export()`. This
is not a convention a consumer has to respect — a consumer that is never handed a private
key structurally cannot leak one, which is a stronger guarantee than a rule saying "don't
log this."

Account creation is therefore anticlimactic on purpose: a user writes their first
comment, you call `getOrCreate()`, a key is generated locally the first time it's needed,
and the event that follows is mined, signed and published under it.

### Device transfer

Moving an identity to another device is SPEC.md §15's encrypted envelope, paired with a
transfer code the client generates — never one the user picks, and never a short numeric
PIN. A photograph of a QR code is enough to attack a weak code offline, at leisure, where
an expiry timestamp protects nothing; entropy is the only thing defending a captured
envelope, which is why `generateTransferCode()` (`@elseweb/protocol`) is required to carry
at least 60 bits.

```js
const { envelope, code } = await client.identity.export()
// Show `envelope` as a QR on the source device.
// Show/read `code` out of band — spoken, typed, or a second confirmation screen. Never
// encode it into the same QR as the envelope, or capturing one photograph captures both.

// On the target device:
await client.identity.import({ envelope, code })
```

`identity.import()` replaces whatever identity is currently on that device. A wrong code
or a tampered envelope fails inside protocol's `unwrapKey()` and propagates as a plain
rejection — nothing is written until the unwrap succeeds, so there is no partially-swapped
identity left behind.

### There is no key recovery

**If the key is lost, the identity is lost.** There is no password reset, no support
ticket, no relay-side recovery, because none of those are possible without a relay or a
third party holding something that lets them reconstruct or override the private key —
which is precisely the thing non-negotiable 5 in the root `AGENTS.md` rules out. The
export/import flow above is the only backup mechanism there is, and it is manual: if a
user never exports their key before losing the device it lived on, everything under that
`pubkey` — content, votes, any accrued standing — becomes permanently unreachable under
that identity. Say this to your own users in the same words. Softening it ("try
contacting support") is a design bug, not customer service.

## 5. Reading

Everything a reader gets back has already been through the two checks a relay cannot be
trusted to have done honestly: every event's `sig` is verified against its `pubkey`, and
every event's `page_id` is recomputed from its `page_url` and compared (SPEC.md §6.3 — a
relay must treat `page_id` as opaque, so this is the only place a forged pairing is ever
caught). Anything that fails either check is silently dropped before it reaches you.

### `readPage` / `readTarget`

`readPage` is `readTarget` under a friendlier name — they are the literal same function
(`packages/client/src/read.js`):

```js
export function readPage(pageUrl, options = {}) {
  return readTarget(pageUrl, options)
}
```

```js
const { target, threads, orphans, votes, events, relaysById } =
  await client.readPage('https://example.com/article')
```

The returned shape, from `createReader`'s `readTarget`:

- **`target`** — `{ page_id, page_url }`, what `deriveTarget()` resolved the URL to.
- **`threads`** — `[{ share, replies, score, relays }]`. `share` and each entry in
  `replies` are full, verified protocol events (so `share.content.text`,
  `share.pubkey`, `share.created_at`, … are all there). `score` is the tallied,
  standing-weighted vote score for that share (`tallyVotes()`, never a raw count).
  `relays` is the list of relay URLs that carried that share — provenance, not a
  trust score.
- **`orphans`** — replies whose `parent_id` was not found among the events this read
  returned. SPEC.md §5.2 requires these be rendered as orphans, never dropped: in a
  federation the parent may simply live on a relay this reader doesn't have configured,
  and discarding it would make the network look emptier the fewer relays a user happens
  to run — backwards from what federation is supposed to buy you.
- **`votes`** — the raw `vote` events for the page, unaggregated.
- **`events`** — the full flat, deduplicated, verified event list `threads`/`orphans`
  were built from, in case you want a different view than threading gives you.
- **`relaysById`** — `Map<eventId, string[]>`, which relays carried *any* event, not
  just shares.

An anchor narrows the read to sub-content on a page (SPEC.md §6, level 2 — a specific post
in a thread, a specific comment):

```js
await client.readTarget('https://example.com/thread/42', { anchorId: 'comment-9' })
```

`timeoutMs` is also accepted and passed down to each relay's own per-request timeout —
useful if your UI needs a page to render even when a relay is unusually slow, since a slow
relay must never hold up a read from the others.

### `readVotes`

For recounting a specific target rather than reading a whole page — SPEC.md §5.3 requires
a relay to serve raw vote events precisely so a client can audit an aggregate it didn't
compute itself:

```js
const { votes, score } = await client.readVotes(shareId)
// votes: raw vote events (kind === 'vote') for this one target_id
// score: the same standing-weighted tally readPage() would have produced for it
```

### `readFeed`

Cross-page, so per-page quotas don't constrain it (Appendix A.2) — which is exactly why a
feed can be gated on attestations while a page-scoped share cannot:

```js
const { events, relaysById } = await client.readFeed({ requiredClaims: ['membership'] })
```

`requiredClaims` is applied against **your own** `trustedIssuers` list, independent of
whatever gate the relay itself enforces (SPEC.md §13). This is what lets ElseWeb's own
attestation-gated feed and a community client's open feed exist over the same network
without either being privileged: each client decides for itself which issuers it trusts,
including trusting none, which — per SPEC.md §8.1 — means trusting nobody's claims rather
than everybody's.

### Domain-level communities are not a separate thing

There is no "community" event kind and no dedicated field. A domain community is just the
normalized site root:

```js
await client.readPage('https://example.com/') // the domain community
await client.publishShare({ pageUrl: 'https://example.com/', text }) // posting into it
```

`relay/test/e2e.test.js` proves this directly: publishing to `https://example.com/` and to
`https://example.com/deep/page` produces two distinct targets, and reading the root only
surfaces the one published at the root.

## 6. Publishing

```js
const { event, results } = await client.publishShare({
  pageUrl: 'https://example.com/',
  text: 'hello from another ElseWeb client',
})
```

All three publish calls — `publishShare`, `publishReply`, `publishVote` — return the same
`{ event, results }` shape. `event` is the final mined-and-signed event (or `null` if
every relay excluded it before mining even started — see §9). `results` is **per relay**,
always, and is never collapsed into a single boolean:

```js
// results: [{ relay, ok: true, id }, { relay, ok: false, code, action, ...extra }]
```

This is not incidental — `publishToRelays()` (`packages/client/src/publish.js`) builds
this array by construction, and `relay/test/e2e.test.js` has a test named exactly for the
failure mode this prevents: *"reports a partial publish as partial rather than as
success."* A relay that rejected while others accepted is information your UI has to be
able to show, because collapsing it into one boolean throws that information away right
where it mattered most.

**Handling a partial success** is the case people get wrong, so handle it explicitly
rather than checking `results[0].ok` and calling it done:

```js
const { event, results } = await client.publishShare({ pageUrl, text })

const accepted = results.filter((result) => result.ok)
const rejected = results.filter((result) => !result.ok)

if (accepted.length === 0) {
  // Nothing took it. `event` may still be non-null (mined, signed, just refused
  // everywhere) — inspect `rejected` for why, using the code/action table in §7.
  showFailure(rejected)
} else if (rejected.length > 0) {
  // Partial success: it exists on the network, but not everywhere you publish to.
  showPartialSuccess({ acceptedBy: accepted.map((r) => r.relay), rejected })
} else {
  showSuccess(event)
}
```

### Sharing, replying, voting

```js
// A top-level share into a page's discussion.
const { event: share } = await client.publishShare({
  pageUrl: 'https://example.com/article',
  text: 'the opening post',
  // anchorId: 'comment-9',        // optional, level-2 target
  // attestations: [ ... ],         // optional, issuer-signed attestations to attach
})

// A reply — takes the parent EVENT OBJECT straight out of a read, not just its id.
await client.publishReply({ parent: share, text: 'answering it' })

// A vote. value must be exactly 1 or -1 — buildVote() throws a TypeError otherwise.
await client.publishVote({ targetId: share.id, value: 1 })
```

`publishReply({ parent, text })` is the shape you'll use in practice: `parent` is a full
event object (from `share` above, or from any event you got back out of `readPage`), and
`buildReply()` (`packages/client/src/events.js`) derives `parent_id`, `root_id`, `page_id`,
`page_url` and `anchor` from it — walking up to the root if `parent` is itself a reply —
after first re-checking that the parent's own `page_id` still hashes its `page_url`
(SPEC.md §6.3 again: a reply denormalizes those fields from its root, so a forged or
corrupted parent must not silently propagate into everything built on top of it). There is
also a lower-level form, `publishReply({ parentId, rootId, pageUrl, anchor, text })`, for
a caller that has ids but not the full parent object — the extension composing a reply
purely from DOM-scraped ids might use this, but reaching for the object form whenever you
have it is simpler and gets the consistency check for free.

## 7. Errors

Every failure surfaces as one type: `ElsewebError`, always with a stable `code` and an
`action` telling you what to do about it. Check with `isElsewebError()` rather than
`instanceof` across a bundler boundary:

```js
import { isElsewebError } from '@elseweb-app/client'
```

| Code | Action | Meaning |
|---|---|---|
| `POW_INSUFFICIENT` | `remine` | Handled internally — see §8. You should not normally see this escape a publish call. |
| `QUOTA_EXCEEDED` | `wait` | Carries `retry_after` (seconds). **Do not re-mine.** |
| `ATTESTATION_REQUIRED` | `surface_to_user` | Carries `required_claims`, `trusted_issuers`. Show it; never retry blindly. |
| `ATTESTATION_INVALID` | `refresh_attestation` | Carries `reason`. Refresh the attestation, then retry. |
| `STALE_TIMESTAMP` | `fix_clock_and_remine` | Clock skew — carries `server_time`, `freshness_window_seconds`. |
| `PAYLOAD_TOO_LARGE` | `shrink_and_remine` | Carries `max_payload_bytes`. Checked before mining starts, not after. |
| `SIGNATURE_INVALID` | `abandon` | Our bug. Do not retry. |
| `SCHEMA_INVALID` | `abandon` | Carries `field`. Our bug. Do not retry. |
| `UNSUPPORTED_VERSION` | `abandon` | Carries `protocol_versions`. This relay cannot take this event, ever. |
| `UNSUPPORTED_KIND` | `abandon_relay` | Carries `kinds`. This one relay excludes the kind; others in the set may not. |
| `NO_IDENTITY` | `create_identity` | Call `identity.getOrCreate()` first. |
| `NO_WRITABLE_RELAY` | `configure_relays` | The relay set has no writable member. |
| `RELAY_UNREACHABLE` | `retry_later` | Reported per relay (§9) — never fatal to the whole publish. |
| `INVALID_TARGET_URL` | `abandon` | Not an `http`/`https` URL, or otherwise fails `deriveTarget()`. |
| `MINING_ABORTED` | `abandon` | Your own `signal` fired. |
| `MINING_EXHAUSTED` | `retry_later` | Hit `maxIterations` without reaching the required difficulty. |

The relay-sent codes (everything from `SCHEMA_INVALID` down through `QUOTA_EXCEEDED`) come
straight off the wire per SPEC.md §16; the codes above that — `NO_IDENTITY`,
`NO_WRITABLE_RELAY`, `INVALID_TARGET_URL`, `MINING_ABORTED`, `MINING_EXHAUSTED`,
`PAYLOAD_TOO_LARGE` (client-side, pre-mining), `RELAY_UNREACHABLE` — never touch a relay
at all. `actionForCode()` (`packages/client/src/errors.js`) is what makes them
indistinguishable to a caller by design: "you have no writable relay configured" and "the
one relay you have is over quota" are the same *kind* of thing to an application deciding
what to show, and splitting them into two error types would just push that union back onto
every caller.

A realistic `try/catch`, showing the two codes people most often confuse:

```js
try {
  const { results } = await client.publishShare({ pageUrl, text })
  const rejection = results.find((result) => !result.ok)
  if (rejection) throw errorFromRejection(rejection) // see note below
} catch (error) {
  if (!isElsewebError(error)) throw error // a real bug, not a protocol outcome

  if (error.code === 'QUOTA_EXCEEDED') {
    // Do NOT re-mine and retry — the relay has already told you it will refuse.
    // Burning proof-of-work on a request you know will be rejected is exactly the
    // trap this code exists to name.
    scheduleRetryAfter(error.retry_after)
    return
  }

  if (error.code === 'POW_INSUFFICIENT') {
    // In practice you will not see this: publishToRelays() already performs exactly
    // one re-mine at the relay's stated required_difficulty before returning. If it
    // still shows up in `results`, the relay asked for more even after that retry —
    // treat it like any other per-relay rejection rather than mining a third time.
    reportRejection(error)
    return
  }

  reportUnexpectedError(error)
}
```

Note that `publishShare`/`publishReply`/`publishVote` **do not throw** for a per-relay
rejection — those come back inside `results`, per §6. The `try/catch` above throws
locally (`NO_IDENTITY`, `INVALID_TARGET_URL`, `PAYLOAD_TOO_LARGE`, a mining failure) or
for a rejection you've deliberately chosen to escalate into a thrown error in your own
code (`errorFromOutcome()` in `packages/client/src/errors.js` exists for exactly that:
turning one of the typed outcomes in `results` back into a throwable `ElsewebError` when
your application wants to treat a single-relay publish's rejection as fatal).

## 8. Proof-of-work

You never construct a nonce or call a mining function directly through the public API —
`publishShare`/`publishReply`/`publishVote` do it internally, in `publishToRelays()`. What
you control from the outside:

```js
const client = createElsewebClient({
  relays,
  identityStore,
  onPowProgress: ({ nonce, iterations }) => updateProgressBar(iterations),
  miningOptions: {
    signal: abortController.signal, // cancellable
    maxIterations: 5_000_000, // bounded — see MINING_EXHAUSTED above
  },
})
```

- **Cancellable** — pass `signal` inside `miningOptions`; an abort surfaces as
  `MINING_ABORTED`. This satisfies SPEC.md §7.4's requirement directly: `createMiner()`
  (`packages/client/src/pow.js`) is a thin translation layer over protocol's own `mine()`,
  which does the actual cancellation.
- **Progress-reporting** — `onPowProgress` is called during the search with
  `{ nonce, iterations }`; also required by §7.4, for a UI that needs to show it isn't
  hung.
- **Bounded** — `maxIterations` stops the search and raises `MINING_EXHAUSTED` rather than
  spinning forever trying to hit a difficulty that isn't achievable in a reasonable time
  budget.

**This proof-of-work is abuse control, not mining in the cryptocurrency sense.** There is
no token, no coin, no blockchain, no reward for doing it, and nothing you accumulate by
doing more of it beyond a lower rejection rate on your next few events. It exists solely
to make posting cost a little real computation, so that flooding a page or a feed costs
proportionally more the more of it you try to do (SPEC.md Appendix A.1–A.2). Difficulty is
read from each relay's `/policy` (and, where a relay exposes it, from `GET /keys/{pubkey}`
for what your specific key currently owes), the highest across the writable relay set is
what gets mined, and it is clamped to each relay's own advertised `max_difficulty` ceiling
before mining starts.

**Off the main thread.** `packages/client/src/pow-worker.js` is a ready-made Web Worker
entry point — the one file in this package allowed to touch `self`/`postMessage`, because
it *is* the worker, not code the rest of the package runs inside. The default mining path
is in-process (fine for a background service worker or a Node process; not fine for
blocking a page's UI thread). To move it off-thread, the host supplies the worker factory:

```js
const worker = new Worker(new URL('@elseweb-app/client/src/pow-worker.js', import.meta.url), {
  type: 'module',
})
```

Wiring that worker into `createElsewebClient`'s mining path is left to the host —
`packages/client/README.md` §7 lists "Web Worker mining by default" under what remains.
Today, using the worker means driving it yourself: post `{ event, difficulty }`, listen
for `{ type: 'progress' | 'result' | 'error', ... }` messages, and hand the resulting
mined event to `signEvent()` yourself if you're bypassing `publishToRelays()` — or wait
for a future version of this package to accept a worker factory as a constructor option.

## 9. Multi-relay

A client holds a **set** of relays. A single relay is that set with one member in it —
never a separate code path, and `packages/client/AGENTS.md` is explicit that adding one
would be a design error, because a single-relay shortcut is exactly how the multi-relay
case rots.

```js
client.relays.add('https://relay.example.com')
client.relays.add({ url: 'https://mirror.example.com', writable: false }) // read-only mirror
client.relays.remove('https://relay.example.com')
client.relays.list() // [{ url, readable, writable }, ...]
```

**If you are running in a browser, the relay has to send CORS headers.** Your page
fetching a relay on another origin is a cross-origin request, and without
`Access-Control-Allow-Origin` the browser will refuse to hand you the response even
though the relay answered correctly — which surfaces as an opaque network failure rather
than a protocol rejection, so it is worth recognizing. The reference relay's Supabase
binding sets those headers and answers `OPTIONS` preflight; a relay you host yourself has
to do the same. See "CORS" in [`RUNNING_A_RELAY.md`](RUNNING_A_RELAY.md).

Note that this is a browser transport concern and not part of the protocol: nothing in
`SPEC.md` requires it, and a relay consumed only from a server or an extension background
worker never needs it.

Changing the set never touches identity — the keypair is the identity; a relay is only
somewhere events are kept (SPEC.md §12).

**On publish** (`publishToRelays()`, `packages/client/src/publish.js`):

1. Every writable relay's policy is fetched (cached per relay, TTL-based). A relay whose
   policy cannot be fetched at all is excluded and reported back as `RELAY_UNREACHABLE` —
   this never aborts the broadcast to the relays that answered fine.
2. Among the relays that answered, one is excluded (and reported `UNSUPPORTED_VERSION` or
   `UNSUPPORTED_KIND`) if its policy doesn't list this event's protocol version or kind at
   all — mining for a relay that will refuse the event on sight is wasted work.
3. Among what's left, the client mines **once**, at the highest `default_difficulty` any
   of those relays' policies require for this kind, clamped to the tightest
   `max_difficulty` any of them advertise.
4. Payload size is checked against the tightest `max_payload_bytes` across those relays
   **before** mining starts (`estimateEncodedBytes()`), not after — there's no reason to
   spend minutes mining something guaranteed to be rejected as too large.
5. The identical signed event is submitted to every relay that survived steps 1–2.
6. If any relay rejects with `POW_INSUFFICIENT`, there is exactly **one** re-mine — at the
   highest `required_difficulty` any of those specific relays actually named, clamped
   again to each one's ceiling — resubmitted only to the relays that asked for more. Not a
   retry loop.

**On read**, the pool fans out to every readable relay, merges by `id` (a content hash, so
dedup needs no coordination), and a relay that's slow, down, or actively hostile never
fails the read from the others — `relay/test/e2e.test.js`'s *"keeps reading when one relay
in the set is down"* is exactly this. `relaysById` on a read result, and `relays` on each
thread, carry the provenance: which relays actually served a given event, which is a weak
positive signal (independent corroboration) and also what makes one relay's outage
invisible in the UI rather than showing up as content flickering in and out.

Relay-set membership is **not persisted by this package.** `relays` is a constructor
argument; if you want the set remembered across a restart, store it through the same
storage port you already have for identity (§3) and pass it back in on the next
`createElsewebClient()` call.

## 10. A complete worked example

This is the same flow `relay/test/e2e.test.js` runs — a real HTTP relay on a real socket,
driven only through the public `@elseweb-app/client` API, with no extension, no ElseWeb UI, no
Supabase and nothing from `relay/src` touched on the client side of the wire. It was run
directly as a Node script against the reference relay to confirm every call in it actually
works as written.

```js
import { createElsewebClient } from '@elseweb-app/client'
// The reference relay, started exactly the way its own end-to-end test does — this half
// is specific to testing against the in-repo relay; a real deployment is just a URL.
import { createRelayApp } from '@elseweb/relay'
import { createMemoryStore } from '@elseweb/relay/test/memory-store.js'
import { makeTestConfig } from '@elseweb/relay/test/fixtures.js'
import { startRelayServer } from '@elseweb/relay/test/http-server.js'

function systemClock() {
  return { now: () => Math.floor(Date.now() / 1000) }
}

// The storage port from section 3 — a plain Map stands in for IndexedDB or
// chrome.storage.local here, which is exactly what lets this same client code run
// against a real relay from a Node script, a browser tab, or a mobile WebView.
function createMemoryIdentityStore() {
  const values = new Map()
  return {
    async get(key) {
      return values.get(key)
    },
    async set(key, value) {
      values.set(key, value)
    },
    async remove(key) {
      values.delete(key)
    },
  }
}

const app = createRelayApp({
  store: createMemoryStore(),
  config: makeTestConfig(),
  clock: systemClock(),
})
const relay = await startRelayServer(app)

const client = createElsewebClient({
  relays: [relay.url],
  identityStore: createMemoryIdentityStore(),
})

// No email, no password, no hosted auth. A keypair is minted locally the first time
// it's needed.
const identity = await client.identity.getOrCreate()
console.log(identity)
// { publicKey: '76214ae1...', identityMode: 'persistent', createdAt: 1787467389 }

const { event: share, results } = await client.publishShare({
  pageUrl: 'https://example.com/',
  text: 'hello from another ElseWeb client',
})
console.log(results)
// [ { relay: 'http://127.0.0.1:55105', ok: true, id: '04f520cc...' } ]

await client.publishReply({ parent: share, text: 'a reply from the same client' })
await client.publishVote({ targetId: share.id, value: 1 })

const { threads } = await client.readPage('https://example.com/')
console.log(threads[0].share.content.text) // 'hello from another ElseWeb client'
console.log(threads[0].replies[0].content.text) // 'a reply from the same client'

const { votes, score } = await client.readVotes(share.id)
console.log(votes.length, score) // 1 2

await relay.close()
```

Everything printed in the comments above is real output from actually running this
script. The only part that's specific to a test setup is starting a relay in-process; a
consumer talking to a deployed relay just replaces `relay.url` with that relay's real
`https://` URL and skips `createRelayApp`/`startRelayServer` entirely.

## 11. What is not done yet

Finished and proven end to end (`relay/test/e2e.test.js` runs the whole thing over real
HTTP): identity, the relay set, policy discovery, the publish pipeline with proof-of-work
including the `POW_INSUFFICIENT` re-mine, reading with verification and threading,
ranking, attestation trust, and the reference relay.

Not done, on purpose, for now:

- **No npm publish.** Both packages are `"private": true`; see §2 for what does and does
  not currently work as a way to depend on this package.
- **No membership issuer.** `verifyAttestation()` and this package's
  `verifyEventAttestations()`/`trustedAttestations()` (`packages/client/src/
  attestations.js`) fully verify an attestation that's presented — signature, issuer trust,
  expiry, subject binding — but nothing in this repository yet *mints* one. An
  attestation-gated feed (`readFeed({ requiredClaims: [...] })`) works today only if you
  hand-construct and sign valid attestations yourself, the way
  `packages/client/test/helpers.js`'s `makeAttestation()` does for tests.
- **Ranking does not use key tier or account age.** `deriveStanding()`
  (`packages/client/src/standing.js`) folds in trusted attestations and `identity_mode`,
  but tier and age are not derivable from a set of events at all — only a per-author
  `GET /keys/{pubkey}` round trip (SPEC.md §7.3, §10) can answer that, and this client does
  not currently make that call on a caller's behalf. `src/standing.js`'s own comment is
  explicit about why: faking that signal from events alone would look like real trust
  while resting on nothing the author actually paid for. A host that wants tier/age folded
  into ranking has to fetch `GET /keys/{pubkey}` itself, per author, and combine it into
  its own `standingByPubkey` before calling `tallyVotes()`/`rankEvents()` directly (both
  are exported from `@elseweb-app/client` for exactly this kind of composition).
- **Relay-set persistence is the host's job**, not this package's — see §9.
- **Web Worker mining is not wired in by default** — the entry point exists
  (`pow-worker.js`), but nothing in `createElsewebClient` currently drives it; see §8.
