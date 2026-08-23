// Regenerates the test vectors. Run from the repo root:
//   node packages/protocol/tools/generate-vectors.mjs
//   node packages/protocol/tools/generate-target-vectors.mjs
//
// The expected values in here — canonical strings, normalized URLs — are HAND-WRITTEN
// from SPEC.md. Only the arithmetic is computed. That is the point: this file is a second,
// independent reading of the spec, written with Node's own crypto rather than the
// WebCrypto the package uses, so agreement between the two means something.
//
// Two rules keep it worth having:
//   1. Never change a vector to make an implementation pass. Change the implementation, or
//      change the spec and this file together and say so.
//   2. If you are implementing a module, do not read this file. Read SPEC.md. The whole
//      value of the vectors is that they were written by someone who was not looking at
//      your code, and it evaporates the moment the reading is shared.
//
// `node packages/protocol/tools/generate-vectors.mjs && git diff --exit-code` proves
// nobody hand-edited a vector.
import crypto from 'node:crypto'
import fs from 'node:fs'

const OUT = new URL('../test/vectors/target.json', import.meta.url)
const sha256hex = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex')

const normalize = [
  { name: 'already canonical', input: 'https://x.com/', normalized: 'https://x.com/' },
  {
    name: 'scheme and host lowercased, path case preserved',
    input: 'HTTPS://X.CoM/Foo',
    normalized: 'https://x.com/Foo',
  },
  { name: 'empty path becomes /', input: 'https://x.com', normalized: 'https://x.com/' },
  {
    name: 'default port removed',
    input: 'https://x.com:443/foo',
    normalized: 'https://x.com/foo',
  },
  {
    name: 'non-default port kept',
    input: 'https://x.com:8443/foo',
    normalized: 'https://x.com:8443/foo',
  },
  { name: 'fragment dropped', input: 'https://x.com/foo#bar', normalized: 'https://x.com/foo' },
  {
    name: 'empty fragment dropped',
    input: 'https://x.com/foo#',
    normalized: 'https://x.com/foo',
  },
  { name: 'userinfo removed', input: 'https://u:p@x.com/foo', normalized: 'https://x.com/foo' },
  {
    name: 'trailing dot on host removed',
    input: 'https://x.com./foo',
    normalized: 'https://x.com/foo',
  },
  {
    name: 'dot segments resolved',
    input: 'https://x.com/a/b/../c',
    normalized: 'https://x.com/a/c',
  },
  {
    name: 'percent-encoded unreserved character decoded',
    input: 'https://x.com/%7Euser',
    normalized: 'https://x.com/~user',
  },
  {
    name: 'percent-encoded reserved character preserved, hex uppercased',
    input: 'https://x.com/a%2fb',
    normalized: 'https://x.com/a%2Fb',
  },
  {
    name: 'trailing slash is significant and preserved',
    input: 'https://x.com/foo/',
    normalized: 'https://x.com/foo/',
  },
  {
    name: 'tracking parameters stripped',
    input: 'https://x.com/foo?utm_source=a&utm_medium=b&fbclid=c&gclid=d',
    normalized: 'https://x.com/foo',
  },
  {
    name: 'remaining query parameters sorted by name',
    input: 'https://x.com/foo?b=2&a=1',
    normalized: 'https://x.com/foo?a=1&b=2',
  },
  {
    name: 'repeated keys sorted by name then value',
    input: 'https://x.com/foo?b=2&a=2&a=1',
    normalized: 'https://x.com/foo?a=1&a=2&b=2',
  },
  {
    name: 'tracking params stripped, real ones kept and sorted',
    input: 'https://x.com/foo?z=1&utm_campaign=x&a=2',
    normalized: 'https://x.com/foo?a=2&z=1',
  },
  {
    name: 'query that is empty after stripping loses the question mark',
    input: 'https://x.com/foo?utm_source=a',
    normalized: 'https://x.com/foo',
  },
  {
    name: 'a valueless parameter becomes name=',
    input: 'https://x.com/foo?a',
    normalized: 'https://x.com/foo?a=',
  },
  {
    name: 'query sort compares UTF-16 code units, not locale order',
    input: 'https://x.com/foo?a=2&B=1',
    normalized: 'https://x.com/foo?B=1&a=2',
  },
  {
    name: 'internationalized host becomes its punycode form',
    input: 'https://türkiye.com/',
    normalized: 'https://xn--trkiye-3ya.com/',
  },
  {
    name: 'http default port removed too',
    input: 'http://x.com:80/foo',
    normalized: 'http://x.com/foo',
  },
  {
    name: 'a real status URL is a level 1 target and is left alone',
    input: 'https://x.com/someone/status/1234567890',
    normalized: 'https://x.com/someone/status/1234567890',
  },
]

const rejected = [
  { name: 'unsupported scheme', input: 'ftp://x.com/foo' },
  { name: 'javascript scheme', input: 'javascript:alert(1)' },
  { name: 'data scheme', input: 'data:text/plain,hi' },
  { name: 'about:blank', input: 'about:blank' },
  { name: 'not a URL', input: 'not a url' },
  { name: 'empty string', input: '' },
]

const distinct = [
  {
    name: 'http and https are different targets',
    a: 'http://x.com/',
    b: 'https://x.com/',
  },
  {
    name: 'trailing slash makes a different target',
    a: 'https://x.com/foo',
    b: 'https://x.com/foo/',
  },
  {
    name: 'path case makes a different target',
    a: 'https://x.com/Foo',
    b: 'https://x.com/foo',
  },
]

const levels = [
  {
    level: 0,
    note: 'The site main feed. The adapter supplies the site root; nothing generic could know this.',
    adapter_canonical_url: 'https://x.com/',
    anchor: null,
  },
  {
    level: 1,
    note: 'A content page reachable by URL.',
    adapter_canonical_url: 'https://x.com/someone/status/1234567890',
    anchor: null,
  },
  {
    level: 2,
    note: 'Sub-content inside that page. page_id is unchanged; the anchor is what narrows it.',
    adapter_canonical_url: 'https://x.com/someone/status/1234567890',
    anchor: { id: '1234567891' },
  },
]

const out = {
  note: 'page_id is hex(SHA-256(utf8(normalized_url))). The anchor is NOT part of page_id; the join key is the pair (page_id, anchor.id).',
  normalize: normalize.map((c) => ({ ...c, page_id: sha256hex(c.normalized) })),
  rejected,
  distinct: distinct.map((c) => ({
    ...c,
    page_id_a: sha256hex(c.a),
    page_id_b: sha256hex(c.b),
  })),
  levels: levels.map((l) => ({ ...l, page_id: sha256hex(l.adapter_canonical_url) })),
  tracking_parameters: [
    'utm_* (any parameter whose name starts with utm_)',
    'fbclid',
    'gclid',
    'gbraid',
    'wbraid',
    'msclkid',
    'dclid',
    'yclid',
    'mc_cid',
    'mc_eid',
    'igshid',
    'ref_src',
    'ref_url',
    '_ga',
  ],
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')
console.log(
  'normalize:',
  out.normalize.length,
  '| rejected:',
  rejected.length,
  '| distinct:',
  distinct.length,
  '| levels:',
  levels.length
)
