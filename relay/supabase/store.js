// The storage port over Postgres. Every Supabase-specific idea in the relay lives here
// and stops here: the core imports this file never, and this file imports the core never.
// See relay/src/store.js for the port's contract — this implements it and nothing else.
//
// Column names differ from protocol field names in exactly two places (`anchor_id` is
// flattened out of the `anchor` object, and `received_at` is the relay's own arrival
// time). Both are mapped here so no caller ever sees a database shape.

const EVENT_COLUMNS =
  'id, v, kind, pubkey, created_at, identity_mode, nonce, attestations, page_id, page_url, anchor_id, parent_id, root_id, target_id, content, sig'

// Rebuilds the protocol's shape from a row, omitting every field the kind does not carry.
// SPEC.md section 4 is strict about this: a field a kind does not require MUST be absent,
// not present-and-null, and a row read back with nulls in it would fail validation at the
// first client that received it.
function toEvent(row) {
  const event = {
    v: row.v,
    kind: row.kind,
    pubkey: row.pubkey,
    created_at: Number(row.created_at),
    identity_mode: row.identity_mode,
    nonce: Number(row.nonce),
    attestations: row.attestations ?? [],
    content: row.content,
    id: row.id,
    sig: row.sig,
  }
  if (row.page_id !== null) event.page_id = row.page_id
  if (row.page_url !== null) event.page_url = row.page_url
  if (row.anchor_id !== null) event.anchor = { id: row.anchor_id }
  if (row.parent_id !== null) event.parent_id = row.parent_id
  if (row.root_id !== null) event.root_id = row.root_id
  if (row.target_id !== null) event.target_id = row.target_id
  return event
}

function toRow(event) {
  return {
    id: event.id,
    v: event.v,
    kind: event.kind,
    pubkey: event.pubkey,
    created_at: event.created_at,
    identity_mode: event.identity_mode,
    nonce: event.nonce,
    attestations: event.attestations,
    page_id: event.page_id ?? null,
    page_url: event.page_url ?? null,
    anchor_id: event.anchor?.id ?? null,
    parent_id: event.parent_id ?? null,
    root_id: event.root_id ?? null,
    target_id: event.target_id ?? null,
    content: event.content,
    sig: event.sig,
  }
}

function unwrap({ data, error }) {
  // Postgres error text never leaves this file. relay/AGENTS.md: responses are the
  // protocol's shapes and nothing more — a leaked constraint name tells an attacker the
  // schema and tells a legitimate client nothing it can act on.
  if (error) throw new Error(`relay storage failure: ${error.code ?? 'unknown'}`)
  return data
}

function secondsToIso(seconds) {
  return new Date(seconds * 1000).toISOString()
}

export function createSupabaseStore(supabase) {
  async function putEvent(event) {
    // The id is a content hash, so the same id is by definition the same event: an
    // upsert that ignores duplicates is the correct idempotent write, not an error case.
    unwrap(
      await supabase
        .from('events')
        .upsert(toRow(event), { onConflict: 'id', ignoreDuplicates: true })
    )
  }

  async function eventsByPage({ pageId, anchorId, limit }) {
    let query = supabase.from('events').select(EVENT_COLUMNS).eq('page_id', pageId)
    if (anchorId) query = query.eq('anchor_id', anchorId)
    const rows = unwrap(await query.order('received_at', { ascending: false }).limit(limit))
    return rows.map(toEvent)
  }

  async function votesByTarget({ targetId, limit }) {
    const rows = unwrap(
      await supabase
        .from('events')
        .select(EVENT_COLUMNS)
        .eq('kind', 'vote')
        .eq('target_id', targetId)
        .order('received_at', { ascending: false })
        .limit(limit)
    )
    return rows.map(toEvent)
  }

  async function feedPage({ cursor, limit }) {
    // The cursor is an arrival timestamp, which is deliberately not the author-claimed
    // created_at: paging on a value the author controls would let a lying clock reorder
    // everyone else's feed.
    let query = supabase
      .from('events')
      .select(`${EVENT_COLUMNS}, received_at`)
      .order('received_at', { ascending: false })
      .limit(limit)
    if (cursor) query = query.lt('received_at', cursor)

    const rows = unwrap(await query)
    return {
      events: rows.map(toEvent),
      nextCursor: rows.length === limit ? rows[rows.length - 1].received_at : null,
    }
  }

  async function keyRecord(pubkey) {
    const rows = unwrap(
      await supabase
        .from('key_records')
        .select('pubkey, first_seen, report_count')
        .eq('pubkey', pubkey)
    )
    if (rows.length === 0) return null
    const [row] = rows
    return {
      pubkey: row.pubkey,
      firstSeenAt: Math.floor(new Date(row.first_seen).getTime() / 1000),
      reports: Number(row.report_count),
    }
  }

  async function bumpQuota({ pubkey, pageId, kind, at }) {
    unwrap(
      await supabase.rpc('elseweb_record_event', {
        p_pubkey: pubkey,
        p_page_id: pageId,
        p_kind: kind,
        p_at: secondsToIso(at),
      })
    )
  }

  async function quotaUsage({ pubkey, pageId, kind, since }) {
    const counts = unwrap(
      await supabase.rpc('elseweb_quota_usage', {
        p_pubkey: pubkey,
        p_page_id: pageId,
        p_kind: kind,
        p_since: secondsToIso(since),
      })
    )
    const [row] = counts ?? []
    return {
      perKey: Number(row?.per_key ?? 0),
      perKeyPerPage: pageId === null ? 0 : Number(row?.per_key_per_page ?? 0),
      perKeyPerKind: kind === null ? 0 : Number(row?.per_key_per_kind ?? 0),
    }
  }

  return { putEvent, eventsByPage, votesByTarget, feedPage, keyRecord, bumpQuota, quotaUsage }
}
