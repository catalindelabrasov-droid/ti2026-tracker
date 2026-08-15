-- A cache the edge function can actually hit.
--
-- live-matches fans out to OpenDota — the league-matches call answers in ~5.6s
-- and /leagues is a one-megabyte download — and measured 8 to 19 SECONDS end to
-- end. The first attempt at fixing that was an in-memory Map inside the
-- function. It never hit: measured 10 requests out of 10 as misses, including
-- four fired in parallel, because Supabase gives almost every request a fresh
-- isolate. Module state is not a cache when nothing stays warm.
--
-- This is the same cache, kept where every isolate can see it.

create table if not exists public.edge_cache (
  key        text primary key,
  body       text        not null,
  updated_at timestamptz not null default now()
);

comment on table public.edge_cache is
  'Shared response cache for edge functions. Written and read only by service_role; an in-isolate Map cannot work here because isolates are not reused.';

-- Nobody but the function. The bodies are public data, but there is no reason
-- for a browser to read or (far worse) write them, and the function runs with
-- the service key.
alter table public.edge_cache enable row level security;
revoke all on public.edge_cache from anon, authenticated;
grant select, insert, update, delete on public.edge_cache to service_role;

-- Keep it small. Entries are replaced by key, so this only matters if a shape
-- stops being requested; an hour of grace is plenty for the longest TTL in use.
create index if not exists edge_cache_updated_at_idx on public.edge_cache (updated_at);
