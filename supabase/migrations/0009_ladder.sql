-- ---------------------------------------------------------------------------
-- The permanent amateur ladder.
--
-- A tournament needs everyone free on the same evening. A ladder doesn't:
-- teams register once, challenge whoever they like whenever they like, and
-- carry a real rating that moves after every series.
--
-- Rating maths: Glicko-1 (Glickman 1995) rather than the Glicko-2 used for the
-- pro world ranking. Glicko-2's volatility step is iterative and assumes
-- batches of games in a rating period; Glicko-1's update is closed-form, so a
-- ladder match can settle the instant it is confirmed. It keeps the part that
-- matters: a rating deviation, so beating a well-established side moves you
-- more than beating an unknown one, and sitting idle makes us less sure of you.
-- ---------------------------------------------------------------------------

create table if not exists public.ladder_teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  tag         text,
  captain_id  uuid not null references auth.users(id) on delete cascade,
  rating      int  not null default 1500,
  rd          int  not null default 350,     -- how unsure we are
  games       int  not null default 0,
  wins        int  not null default 0,
  losses      int  not null default 0,
  streak      int  not null default 0,       -- + for a winning run, - for losing
  peak_rating int  not null default 1500,
  last_played timestamptz,
  created_at  timestamptz not null default now()
);
create unique index if not exists ladder_name_uniq on public.ladder_teams (lower(name));
create unique index if not exists ladder_captain_uniq on public.ladder_teams (captain_id);

create table if not exists public.ladder_challenges (
  id            uuid primary key default gen_random_uuid(),
  challenger_id uuid not null references public.ladder_teams(id) on delete cascade,
  opponent_id   uuid not null references public.ladder_teams(id) on delete cascade,
  best_of       int  not null default 3,
  message       text,
  status        text not null default 'open',  -- open | accepted | declined | played | withdrawn
  proposed_for  timestamptz,                   -- a suggested time, optional
  created_at    timestamptz not null default now(),
  responded_at  timestamptz,
  expires_at    timestamptz not null default (now() + interval '7 days'),
  check (challenger_id <> opponent_id)
);
create index if not exists lc_open_idx on public.ladder_challenges (opponent_id, status);

create table if not exists public.ladder_matches (
  id           uuid primary key default gen_random_uuid(),
  challenge_id uuid references public.ladder_challenges(id) on delete set null,
  team_a       uuid not null references public.ladder_teams(id) on delete cascade,
  team_b       uuid not null references public.ladder_teams(id) on delete cascade,
  best_of      int  not null default 3,
  score_a      int  not null default 0,
  score_b      int  not null default 0,
  winner_id    uuid references public.ladder_teams(id) on delete set null,
  dota_matches jsonb not null default '[]'::jsonb,
  status       text not null default 'reported',  -- reported | done
  reported_by  uuid,
  confirmed_by uuid,
  -- Kept so the ladder can show what a result was actually worth.
  rating_a_before int, rating_b_before int,
  rating_a_after  int, rating_b_after  int,
  created_at   timestamptz not null default now(),
  played_at    timestamptz
);
create index if not exists lm_team_idx on public.ladder_matches (team_a, team_b);

alter table public.ladder_teams      enable row level security;
alter table public.ladder_challenges enable row level security;
alter table public.ladder_matches    enable row level security;

drop policy if exists "ladder teams readable"   on public.ladder_teams;
drop policy if exists "ladder teams register"   on public.ladder_teams;
drop policy if exists "ladder teams edit"       on public.ladder_teams;
create policy "ladder teams readable" on public.ladder_teams for select using (true);
create policy "ladder teams register" on public.ladder_teams for insert to authenticated
  with check (captain_id = auth.uid());
-- Only your own team, and never your own rating: that only moves through a match.
create policy "ladder teams edit" on public.ladder_teams for update to authenticated
  using (captain_id = auth.uid());

drop policy if exists "challenges readable" on public.ladder_challenges;
create policy "challenges readable" on public.ladder_challenges for select using (true);

drop policy if exists "ladder matches readable" on public.ladder_matches;
create policy "ladder matches readable" on public.ladder_matches for select using (true);

grant select on public.ladder_teams, public.ladder_challenges, public.ladder_matches to anon, authenticated;
grant insert, update on public.ladder_teams to authenticated;
grant select, insert, update, delete
  on public.ladder_teams, public.ladder_challenges, public.ladder_matches to service_role;

-- --- rating maths ----------------------------------------------------------

-- Glicko's g(): the weight given to an opponent whose rating we're unsure of.
create or replace function public.glicko_g(rd numeric)
returns numeric language sql immutable as $$
  select 1.0 / sqrt(1.0 + 3.0 * 0.0057564693 ^ 2 * rd ^ 2 / (pi() ^ 2));
$$;

-- Expected score for `rating` against an opponent.
create or replace function public.glicko_e(rating numeric, opp_rating numeric, opp_rd numeric)
returns numeric language sql immutable as $$
  select 1.0 / (1.0 + power(10.0, -glicko_g(opp_rd) * (rating - opp_rating) / 400.0));
$$;

-- One team's new (rating, rd) after a series against one opponent.
-- score is 1 for a win, 0 for a loss.
create or replace function public.glicko_update(
  rating numeric, rd numeric, opp_rating numeric, opp_rd numeric, score numeric)
returns table(new_rating int, new_rd int)
language plpgsql immutable as $$
declare
  q  numeric := 0.0057564693;   -- ln(10)/400
  g  numeric; e numeric; d2 numeric; denom numeric; nr numeric; nrd numeric;
begin
  g := glicko_g(opp_rd);
  e := glicko_e(rating, opp_rating, opp_rd);
  -- A perfectly certain result would divide by zero; clamp the extremes.
  e := least(greatest(e, 0.0001), 0.9999);
  d2 := 1.0 / (q * q * g * g * e * (1.0 - e));
  denom := 1.0 / (rd * rd) + 1.0 / d2;
  nr  := rating + (q / denom) * g * (score - e);
  nrd := sqrt(1.0 / denom);
  -- Never claim more certainty than 30, nor less than the starting 350.
  return query select round(nr)::int, least(greatest(round(nrd), 30), 350)::int;
end $$;

-- A rating we haven't tested in months is worth less confidence. Rather than
-- rewriting rows on a timer, the deviation is inflated at the moment it's
-- used: RD' = min(sqrt(RD^2 + c^2 * days), 350). c = 15 takes a settled team
-- from RD 100 back to roughly 300 after a year off.
create or replace function public.ladder_live_rd(rd int, last_played timestamptz)
returns int language sql immutable as $$
  select least(
    round(sqrt(rd::numeric ^ 2 + 225.0 *
      greatest(0, extract(epoch from (now() - coalesce(last_played, now()))) / 86400.0))),
    350)::int;
$$;

-- The public ladder, strongest first. Ordering is by the rating we're
-- confident a team is at least worth, so a 2-0 newcomer can't sit at the top.
create or replace view public.ladder_standings as
  select t.id, t.name, t.tag, t.captain_id, t.rating,
         ladder_live_rd(t.rd, t.last_played) as rd,
         (t.rating - 2 * ladder_live_rd(t.rd, t.last_played)) as confident_rating,
         t.games, t.wins, t.losses, t.streak, t.peak_rating, t.last_played,
         (t.games < 5 or ladder_live_rd(t.rd, t.last_played) > 150) as provisional
  from ladder_teams t;

grant select on public.ladder_standings to anon, authenticated;

-- --- flows -----------------------------------------------------------------

-- Challenge another team. One open challenge per pairing at a time.
create or replace function public.ladder_challenge(
  p_opponent uuid, p_best_of int default 3, p_message text default null,
  p_when timestamptz default null)
returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare mine uuid; cid uuid;
begin
  select id into mine from ladder_teams where captain_id = auth.uid();
  if mine is null then raise exception 'Register a team on the ladder first.'; end if;
  if mine = p_opponent then raise exception 'You cannot challenge your own team.'; end if;
  if p_best_of not in (1,3,5) then raise exception 'Series must be Bo1, Bo3 or Bo5.'; end if;
  if exists (select 1 from ladder_challenges
             where status='open' and expires_at > now()
               and ((challenger_id=mine and opponent_id=p_opponent)
                 or (challenger_id=p_opponent and opponent_id=mine))) then
    raise exception 'There is already an open challenge between these two teams.';
  end if;
  insert into ladder_challenges (challenger_id,opponent_id,best_of,message,proposed_for)
  values (mine,p_opponent,p_best_of,p_message,p_when) returning id into cid;
  return cid;
end $$;

-- Accept or decline a challenge aimed at your team.
create or replace function public.ladder_respond(p_challenge uuid, p_accept boolean)
returns text
language plpgsql security definer set search_path to 'public' as $$
declare c ladder_challenges%rowtype; mine uuid;
begin
  select * into c from ladder_challenges where id = p_challenge;
  if c.id is null then raise exception 'Challenge not found.'; end if;
  select id into mine from ladder_teams where captain_id = auth.uid();
  if mine is null or mine <> c.opponent_id then
    raise exception 'Only the challenged team can answer this.';
  end if;
  if c.status <> 'open' then raise exception 'That challenge is no longer open.'; end if;
  update ladder_challenges
    set status = case when p_accept then 'accepted' else 'declined' end, responded_at = now()
  where id = p_challenge;
  return case when p_accept then 'accepted' else 'declined' end;
end $$;

-- Report a ladder result. Same rule as tournaments: the other captain
-- confirms before anything counts, so nobody can rate themselves up.
create or replace function public.ladder_report(
  p_challenge uuid, p_score_a int, p_score_b int, p_dota_ids jsonb default '[]'::jsonb)
returns text
language plpgsql security definer set search_path to 'public' as $$
declare
  c ladder_challenges%rowtype;
  m ladder_matches%rowtype;
  mine uuid; need int; a uuid; b uuid;
begin
  select * into c from ladder_challenges where id = p_challenge;
  if c.id is null then raise exception 'Challenge not found.'; end if;
  if c.status not in ('accepted','played') then raise exception 'That challenge has not been accepted.'; end if;
  select id into mine from ladder_teams where captain_id = auth.uid();
  if mine is null or (mine <> c.challenger_id and mine <> c.opponent_id) then
    raise exception 'Only the two captains can report this.';
  end if;

  a := c.challenger_id; b := c.opponent_id;
  need := c.best_of / 2 + 1;
  if greatest(p_score_a,p_score_b) <> need or p_score_a + p_score_b > c.best_of
     or p_score_a < 0 or p_score_b < 0 then
    raise exception 'A Bo% is won with % games.', c.best_of, need;
  end if;

  select * into m from ladder_matches where challenge_id = p_challenge and status = 'reported';
  if m.id is null then
    insert into ladder_matches (challenge_id,team_a,team_b,best_of,score_a,score_b,
                                dota_matches,reported_by,status)
    values (p_challenge,a,b,c.best_of,p_score_a,p_score_b,p_dota_ids,auth.uid(),'reported');
    return 'reported';
  end if;

  if m.reported_by = auth.uid() then
    update ladder_matches set score_a=p_score_a, score_b=p_score_b, dota_matches=p_dota_ids
    where id = m.id;
    return 'updated';
  end if;
  if m.score_a <> p_score_a or m.score_b <> p_score_b then
    raise exception 'That is not what the other captain reported (% - %). Agree the score first.', m.score_a, m.score_b;
  end if;
  perform ladder_settle(m.id);
  return 'confirmed';
end $$;

-- Apply a confirmed result: move both ratings and the streaks.
create or replace function public.ladder_settle(p_match uuid)
returns void
language plpgsql security definer set search_path to 'public' as $$
declare
  m ladder_matches%rowtype;
  ta ladder_teams%rowtype; tb ladder_teams%rowtype;
  ra record; rb record;
  a_won boolean;
begin
  select * into m from ladder_matches where id = p_match;
  if m.status = 'done' then return; end if;
  select * into ta from ladder_teams where id = m.team_a;
  select * into tb from ladder_teams where id = m.team_b;
  a_won := m.score_a > m.score_b;

  -- Both updates use the ratings held BEFORE the match, so the order in which
  -- we write them cannot change the outcome. Deviations are the inactivity-
  -- inflated ones, so a team returning after months moves further.
  declare
    rda int := ladder_live_rd(ta.rd, ta.last_played);
    rdb int := ladder_live_rd(tb.rd, tb.last_played);
  begin
    select * into ra from glicko_update(ta.rating, rda, tb.rating, rdb, case when a_won then 1 else 0 end);
    select * into rb from glicko_update(tb.rating, rdb, ta.rating, rda, case when a_won then 0 else 1 end);
  end;

  update ladder_teams set
    rating = ra.new_rating, rd = ra.new_rd, games = games + 1,
    wins = wins + (case when a_won then 1 else 0 end),
    losses = losses + (case when a_won then 0 else 1 end),
    streak = case when a_won then greatest(streak,0) + 1 else least(streak,0) - 1 end,
    peak_rating = greatest(peak_rating, ra.new_rating),
    last_played = now()
  where id = ta.id;

  update ladder_teams set
    rating = rb.new_rating, rd = rb.new_rd, games = games + 1,
    wins = wins + (case when a_won then 0 else 1 end),
    losses = losses + (case when a_won then 1 else 0 end),
    streak = case when a_won then least(streak,0) - 1 else greatest(streak,0) + 1 end,
    peak_rating = greatest(peak_rating, rb.new_rating),
    last_played = now()
  where id = tb.id;

  update ladder_matches set
    status='done', winner_id = case when a_won then m.team_a else m.team_b end,
    confirmed_by = auth.uid(), played_at = now(),
    rating_a_before = ta.rating, rating_b_before = tb.rating,
    rating_a_after  = ra.new_rating, rating_b_after = rb.new_rating
  where id = p_match;

  update ladder_challenges set status='played' where id = m.challenge_id;
end $$;

grant execute on function public.ladder_challenge(uuid,int,text,timestamptz) to authenticated;
grant execute on function public.ladder_respond(uuid,boolean) to authenticated;
grant execute on function public.ladder_report(uuid,int,int,jsonb) to authenticated;
grant execute on function public.ladder_settle(uuid) to authenticated, service_role;
grant execute on function public.glicko_update(numeric,numeric,numeric,numeric,numeric) to authenticated, service_role;
