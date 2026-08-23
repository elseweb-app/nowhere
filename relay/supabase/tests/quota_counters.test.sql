-- Regression test for the quota_counters primary key bug: page_id is intentionally
-- nullable (NULL = per-key counter), and elseweb_record_event always inserts a
-- NULL-page_id row. A primary key over a nullable column made that insert
-- impossible, so a POST /events stored the event and then failed in bumpQuota(),
-- surfacing as HTTP 500. See 20260823000100_fix_quota_counters_pk.sql.
--
-- Run with: supabase test db (spins up a local Postgres, applies every migration,
-- then runs this file with pgTAP).

begin;
select plan(4);

select lives_ok(
  $$ select public.elseweb_record_event(
       'aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11',
       'bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22',
       'share',
       now()
     ) $$,
  'recording a page-scoped event does not fail on the NULL-page_id per-key counter insert'
);

select lives_ok(
  $$ select public.elseweb_record_event(
       'aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11',
       null,
       'vote',
       now()
     ) $$,
  'recording a vote (no page_id) still works alongside the earlier per-key row'
);

select is(
  (select per_key from public.elseweb_quota_usage(
     'aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11',
     null, null, now() - interval '1 day'
   )),
  2::bigint,
  'both events count toward the per-key total'
);

select is(
  (select per_key_per_page from public.elseweb_quota_usage(
     'aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11',
     'bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22',
     null, now() - interval '1 day'
   )),
  1::bigint,
  'only the page-scoped event counts toward the per-(key, page) total'
);

select * from finish();
rollback;
