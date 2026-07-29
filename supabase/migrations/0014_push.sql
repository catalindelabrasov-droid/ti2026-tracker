-- ---------------------------------------------------------------------------
-- Web push, so a match starting reaches a phone that is in a pocket.
--
-- The site already had a bell, but it fired `new Notification()` from the page
-- — which only works while the page is open. That is the one situation where a
-- notification is useless: if you are looking at the tab, you can already see
-- the match started.
--
-- Real push needs three things the browser cannot do alone: somewhere to keep
-- the subscription, something that notices a match has started, and something
-- that sends. This migration is the first; the push-tick function is the other
-- two.
-- ---------------------------------------------------------------------------

create table if not exists public.push_subscriptions (
  endpoint   text primary key,          -- the push service URL; unique per device
  p256dh     text not null,             -- the device's public key
  auth       text not null,             -- the shared auth secret
  user_id    uuid references auth.users(id) on delete cascade,
  topics     text[] not null default array['ti'],
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok    timestamptz,
  failures   int not null default 0
);
create index if not exists ps_topics_idx on public.push_subscriptions using gin (topics);

-- One row per thing announced, so a restart or an overlapping run cannot tell
-- somebody the same match started twice.
create table if not exists public.push_log (
  match_key text not null,
  kind      text not null,              -- live | soon
  sent_at   timestamptz not null default now(),
  sent_to   int not null default 0,
  primary key (match_key, kind)
);
create index if not exists pl_sent_idx on public.push_log (sent_at);

-- Settings that must be changeable without a redeploy. The TI 2026 league id
-- does not exist on OpenDota yet — Valve publishes it days before the event —
-- so it cannot be baked into anything.
create table if not exists public.app_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
insert into public.app_config (key, value) values
  ('ti_league_ids', '[]'::jsonb),
  ('push_soon_minutes', '10'::jsonb)
on conflict (key) do nothing;

alter table public.push_subscriptions enable row level security;
alter table public.push_log           enable row level security;
alter table public.app_config         enable row level security;

-- Deliberately no policies: a push endpoint is a capability. Anyone who could
-- read this table could send notifications to every user of the site. Nothing
-- reaches it except the security definer functions below and service_role.
revoke all on public.push_subscriptions from anon, authenticated;
revoke all on public.push_log           from anon, authenticated;
revoke all on public.app_config         from anon, authenticated;


-- Register a device. Upsert on endpoint: browsers reissue the same endpoint
-- for the same installation, and a device that re-subscribes after a failure
-- should come back clean rather than pile up duplicates.
create or replace function public.push_subscribe(
  p_endpoint text, p_p256dh text, p_auth text,
  p_topics text[] default array['ti'], p_user_agent text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if p_endpoint is null or length(p_endpoint) < 20 then
    raise exception 'That is not a usable push endpoint.';
  end if;
  insert into push_subscriptions (endpoint, p256dh, auth, user_id, topics, user_agent, failures)
  values (p_endpoint, p_p256dh, p_auth, auth.uid(), coalesce(p_topics, array['ti']), p_user_agent, 0)
  on conflict (endpoint) do update
    set p256dh = excluded.p256dh,
        auth = excluded.auth,
        user_id = coalesce(excluded.user_id, push_subscriptions.user_id),
        topics = excluded.topics,
        user_agent = excluded.user_agent,
        failures = 0;
end $function$;

create or replace function public.push_unsubscribe(p_endpoint text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  delete from push_subscriptions where endpoint = p_endpoint;
end $function$;

grant execute on function public.push_subscribe(text,text,text,text[],text) to anon, authenticated;
grant execute on function public.push_unsubscribe(text) to anon, authenticated;

grant select, insert, update, delete
  on public.push_subscriptions, public.push_log, public.app_config to service_role;
