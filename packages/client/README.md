# `@elseweb/client`

Everything a client does that is not user interface: the relay set, publishing, reading
and merging, key management, proof-of-work and ranking.

It runs unchanged in an MV3 service worker or any other JavaScript host — a web page, a
Capacitor WebView, a Node script — because it contains no platform API at all. Storage
and a clock are **ports you inject**; `fetch` is the one global it uses, and even that
is injectable.

**No extension is required to join the ElseWeb network.** This package is the whole
client; the browser extension is one host of it, not a prerequisite.

---

## 1. Instantiating the client

```js
import { createElsewebClient } from '@elseweb/client'

const client = createElsewebClient({
  relays: ['https://relay.example.com'],
  identityStore: browserIdentityStore,
})

await client.identity.getOrCreate()

await client.publishShare({
  pageUrl: 'https://example.com/',
  text: 'hello from another ElseWeb client',
})

const discussion = await client.readPage('https://example.com/')
```

Full options:

| Option | Required | Meaning |
|---|---|---|
| `relays` | yes in practice | URL strings, or `{ url, readable, writable }` objects |
| `identityStore` | **yes** | The storage port (§2) |
| `clock` | no | `{ now() }` in Unix **seconds**. Defaults to `Date` |
| `fetch` | no | Defaults to `globalThis.fetch` |
| `trustedIssuers` | no | Hex pubkeys whose attestations count. **Empty trusts nobody** |
| `canonicalizeUrl` | no | Hook for a site adapter's canonical URL |
| `limit` | no | Cap on events per view |
| `onPowProgress` | no | `({ nonce, iterations }) => void` |

## 2. Browser identity persistence

Identity is an Ed25519 keypair that belongs to the user. There is no email, no password,
no hosted auth, and no server-side account creation. The private key is never sent to a
relay, encrypted or not.

The package stores nothing itself — it calls the port you give it. A browser
implementation over IndexedDB, copy-pasteable:

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

The API:

```js
await client.identity.get()          // { publicKey, identityMode, createdAt } | null
await client.identity.getOrCreate()  // the common startup call
await client.identity.create()       // a deliberate fresh key ("start over")
await client.identity.clear()
const { envelope, code } = await client.identity.export()  // encrypted, for device transfer
await client.identity.import({ envelope, code })
```

**`identity.get()` never returns a private key.** The seed stays inside the client and
leaves only through `identity.export()`, inside the encrypted envelope of SPEC §15,
decrypted with a high-entropy code the client generates and the user carries separately
from the envelope. A consumer that is never handed a seed cannot leak one.

Account creation is therefore just: the user writes their first comment, you call
`getOrCreate()`, a key is generated locally, and the event is mined, signed and published.

## 3. Configuring relays

A client holds a **set** of relays, editable at any time. A single relay is a set of one,
never a special case.

```js
client.relays.add('https://relay.example.com')
client.relays.add({ url: 'https://mirror.example.com', writable: false })
client.relays.remove('https://relay.example.com')
client.relays.list()
```

Changing relays never affects identity — the keypair is the identity, a relay is only a
place events are kept.

On publish the client discovers each writable relay's policy, mines **once** at the
highest difficulty the set requires, and submits the same event to each. On read it fans
out to every readable relay and merges; because `id` is a content hash, deduplication is
free. **A slow, failing or hostile relay never fails a read**, and a relay whose policy
cannot be read is excluded from a publish rather than aborting it.

`publish*` returns per-relay outcomes and never collapses them into one boolean:

```js
const { event, results } = await client.publishShare({ pageUrl, text })
// results: [{ relay, ok: true, id }, { relay, ok: false, code, action, ...extra }]
```

A partial success is visible as a partial success. That is deliberate — a relay that
rejected while others accepted is information the user needs.

## 4. Proof of work

Handled internally. You never see a nonce.

The client reads the required difficulty from each relay's policy document (and, where
available, from `GET /keys/{pubkey}` for what *your* key currently owes), takes the
highest across the writable set, clamps it to each relay's ceiling, mines, signs and
broadcasts. A `POW_INSUFFICIENT` rejection triggers exactly **one** re-mine, at the
difficulty the relay actually named, and only against the relays that asked for more.

Three things the spec requires and this does:

- **Cancellable** — pass a `signal` through `miningOptions`.
- **Progress-reporting** — `onPowProgress`.
- **Bounded** — mining stops at a configured effort and raises `MINING_EXHAUSTED` rather
  than appearing to hang.

Because `created_at` is committed to by the work, mining that outlasts a relay's freshness
window would be rejected everywhere. The client checks freshness after mining and rebuilds
with a fresh timestamp if needed.

To keep mining off the UI thread, hand the client a worker factory; `pow-worker.js` is
shipped as the worker entry. The default is in-process.

## 5. How errors surface

Everything throws or reports a single `ElsewebError` with a stable `code` and an `action`
saying what to do about it.

| Code | Action | Meaning |
|---|---|---|
| `POW_INSUFFICIENT` | `remine` | Handled internally; carries `required_difficulty` |
| `QUOTA_EXCEEDED` | `wait` | Carries `retry_after`. **Do not re-mine** |
| `ATTESTATION_REQUIRED` | `surface_to_user` | Show it. Never retry blindly |
| `ATTESTATION_INVALID` | `refresh_attestation` | Refresh, then retry |
| `STALE_TIMESTAMP` | `fix_clock_and_remine` | Clock skew |
| `PAYLOAD_TOO_LARGE` | `shrink_and_remine` | Checked before mining, not after |
| `SIGNATURE_INVALID` / `SCHEMA_INVALID` | `abandon` | Our bug. Do not retry |
| `UNSUPPORTED_VERSION` / `UNSUPPORTED_KIND` | `abandon` / `abandon_relay` | Relay cannot take it |
| `NO_IDENTITY` | `create_identity` | Call `identity.getOrCreate()` |
| `NO_WRITABLE_RELAY` | `configure_relays` | The set has no writable relay |
| `RELAY_UNREACHABLE` | `retry_later` | Reported per relay, never fatal |
| `INVALID_TARGET_URL` | `abandon` | Not an `http`/`https` URL |
| `MINING_ABORTED` / `MINING_EXHAUSTED` | `abandon` / `retry_later` | Local mining outcome |

```js
import { isElsewebError } from '@elseweb/client'

try {
  await client.publishShare({ pageUrl, text })
} catch (error) {
  if (isElsewebError(error) && error.code === 'QUOTA_EXCEEDED') {
    showRetryAfter(error.retry_after)
  }
}
```

## 6. Integrating another client

Reading returns validated, ranked, threaded structures:

```js
const { target, threads, orphans, votes } = await client.readPage('https://example.com/')
// threads: [{ share, replies, score, relays }]

await client.readTarget('https://example.com/post', { anchorId: '12345' })
await client.readVotes(shareId)   // raw vote events plus a recountable score
await client.readFeed({ requiredClaims: ['membership'] })
```

Two things the client verifies so you do not have to: every event's signature, and that
`page_id` really hashes `page_url` (a relay must treat page identity as opaque, so a
forged pairing is only ever caught here). Anything that fails is dropped.

A reply whose parent is missing comes back in `orphans` rather than being discarded — in
a federation the parent may live on a relay you do not use.

**A domain-level community is just the normalized site root.** There is no separate
concept and no separate event kind:

```js
await client.readPage('https://example.com/')                       // the domain community
await client.publishShare({ pageUrl: 'https://example.com/', text }) // posting into it
```

Raw events stay reachable on every read result, so nothing forces you through the
threading if you want to build a different view.

## 7. What remains before the extension phase

Finished and proven end to end: identity, the relay set, policy discovery, the publish
pipeline with proof-of-work, reading with verification and threading, ranking, attestation
trust, and the reference relay. `relay/test/e2e.test.js` runs the whole flow over real
HTTP.

Not done, and deliberately out of this phase:

- **Extension hosting** — content script, shadow-DOM UI, composer button, popup, options.
  The extension becomes another host of this package; none of it changes this package.
- **The membership issuer.** Attestations are verified here; nothing mints them yet.
- **Per-author key tier and age in ranking.** `deriveStanding()` weights trusted
  attestations and identity mode. Tier and age need a `GET /keys/{pubkey}` round trip per
  author, which the client does not currently make — the gap is documented in
  `src/standing.js` rather than faked.
- **Relay-set persistence.** The set is a constructor argument; a host that wants it
  remembered stores it through the same port it uses for identity.
- **Web Worker mining by default.** The entry exists; wiring it is the host's choice.
