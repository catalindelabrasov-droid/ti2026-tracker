-- ---------------------------------------------------------------------------
-- Staged tournaments — and three things that were already broken.
--
-- Single and double elimination can be generated in full the moment the
-- tournament starts, because the shape of the bracket does not depend on who
-- wins. Swiss and a group stage are different: round two of a Swiss pairs
-- teams by their round-one record, and a playoff bracket is seeded from final
-- group standings. Neither can exist before the previous stage has been played.
--
-- So a tournament gains a STAGE, and one function decides what happens when a
-- stage runs out of matches: generate the next thing, or crown a champion.
-- Everything still happens inside the RPC the captain triggered by confirming
-- a result — there is no scheduler here, and there does not need to be.
--
-- Building that turned up three bugs in what already shipped. They are fixed
-- here rather than later, because the new formats walk straight into all three.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- 1. Anyone at all could settle any match.
--
-- tournament_confirm was left with the default PUBLIC execute grant, and its
-- body never checks who is calling — it reads the stored score and moves the
-- bracket. A pending match is 0-0, so a stranger with the anon key (which is
-- in the page source, as it is meant to be) could call it on any match id and
-- award the series to team B, over and over, until somebody's tournament was
-- finished with a champion nobody played for.
--
-- The fix is to make it unreachable from outside. tournament_report is the
-- front door, it checks the caller is one of the two captains or the
-- organiser, and being SECURITY DEFINER it can still call confirm internally.
-- ===========================================================================
revoke execute on function public.tournament_confirm(uuid)       from public, authenticated;
revoke execute on function public.tournament_resolve_byes(uuid)  from public, authenticated;
revoke execute on function public.tournament_report(uuid,int,int,jsonb) from public;
grant  execute on function public.tournament_report(uuid,int,int,jsonb) to authenticated;

-- Table privileges were similarly wide. An organiser could PATCH their own
-- tournament row directly — including format, status and champion_id, mid
-- event — and a captain could edit their own team row, which since this
-- migration includes the group they were drawn into, and has always included
-- the seed that decides who they play. Neither should be client-writable.
revoke update on public.tournaments      from authenticated;
grant  update (name, description, visibility, starts_at, max_teams)
  on public.tournaments to authenticated;
revoke update on public.tournament_teams from authenticated;
grant  update (name, tag, roster) on public.tournament_teams to authenticated;

-- Withdrawing was a hard delete, allowed at any point. The match rows point at
-- the team with on delete set null, so a captain who disliked a pairing could
-- delete their team and blank themselves out of every result they had already
-- played — taking their opponents' records with them. Withdrawal now only
-- exists before the tournament starts, which is the only time the front end
-- offers it anyway.
drop policy if exists "teams withdraw" on public.tournament_teams;
create policy "teams withdraw" on public.tournament_teams for delete to authenticated
  using (
    exists (select 1 from public.tournaments t
             where t.id = tournament_id and t.status = 'registration')
    and (captain_id = auth.uid()
         or exists (select 1 from public.tournaments t
                     where t.id = tournament_id and t.organiser_id = auth.uid()))
  );

-- A format the generator does not recognise used to fall through to the
-- single-elimination branch and silently build the wrong tournament.
alter table public.tournaments drop constraint if exists tournaments_format_ck;
alter table public.tournaments add constraint tournaments_format_ck
  check (format in ('single_elim','double_elim','round_robin','swiss','groups'));


-- ===========================================================================
-- 2. Double elimination never finished unless the field was a power of two.
--
-- Verified against the live database before writing this: 3, 5, 6 and 7 team
-- double-elimination tournaments deadlock permanently, with between three and
-- seven matches pending forever. 8 teams is fine. The create form offers 6,
-- 12 and 24.
--
-- The cause: a bye has no loser. The winners-bracket slot resolves, its winner
-- advances, but the losers-bracket slot its loser_match_id points at is never
-- filled — and tournament_resolve_byes only ever looked at bracket='main', so
-- it could not clear it either.
--
-- Two changes. Byes are resolved in every bracket, and a match is only
-- considered unfillable when nothing can still reach it through EITHER
-- pointer. A match that ends up with no teams at all — both of its feeders
-- were byes — is closed with no winner and passes nobody on, which lets the
-- round after it resolve in turn.
-- ===========================================================================
create or replace function public.tournament_resolve_byes(p_tournament uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  changed boolean := true;
  rec     record;
  who     uuid;
begin
  while changed loop
    changed := false;
    for rec in
      select m.* from tournament_matches m
      where m.tournament_id = p_tournament
        and m.status <> 'done'
        and (m.team_a is null or m.team_b is null)
        -- Nothing unfinished can still deliver a team here. A feeder that was
        -- itself a bye is already done and produced no loser, which is exactly
        -- the case that used to leave the losers bracket waiting for ever.
        and not exists (
          select 1 from tournament_matches f
           where f.tournament_id = p_tournament
             and f.status <> 'done'
             and (f.next_match_id = m.id or f.loser_match_id = m.id))
      order by m.round, m.slot, m.bracket
    loop
      who := coalesce(rec.team_a, rec.team_b);

      -- Don't touch the label: it names the ROUND and is read as a heading.
      -- A bye is recognisable from "finished with one empty side".
      update tournament_matches
         set status = 'done', winner_id = who, updated_at = now()
       where id = rec.id;

      if who is not null and rec.next_match_id is not null then
        if rec.next_is_a then
          update tournament_matches set team_a = who where id = rec.next_match_id;
        else
          update tournament_matches set team_b = who where id = rec.next_match_id;
        end if;
        update tournament_matches set status = 'ready'
         where id = rec.next_match_id
           and team_a is not null and team_b is not null and status = 'pending';
      end if;

      changed := true;
    end loop;
  end loop;
end $function$;


-- ===========================================================================
-- 3. The stage machine.
-- ===========================================================================

alter table public.tournaments
  add column if not exists stage        text,
  add column if not exists stage_config jsonb not null default '{}'::jsonb;

comment on column public.tournaments.stage is
  'Which phase is being played now: swiss | groups | playoffs. Null for formats that have only one phase.';
comment on column public.tournaments.stage_config is
  'Format-specific settings fixed at creation: Swiss round count and thresholds, group count, teams advancing, playoff format.';

-- Group membership. Kept on the team rather than derived from matches so the
-- draw can be shown the instant it is made, before anyone has played.
alter table public.tournament_teams
  add column if not exists group_no int;

alter table public.tournament_matches
  add column if not exists group_no int;

-- Per-match facts that are neither structure nor result: which record a Swiss
-- pairing was drawn from, whether a match is somebody's last chance, whether
-- the pairer had to repeat a fixture.
alter table public.tournament_matches
  add column if not exists meta jsonb not null default '{}'::jsonb;

-- The old uniqueness rule was (tournament, bracket, round, slot). Group B's
-- round 1 slot 1 would collide with group A's, so the draw could not be
-- inserted. The group has to be part of the key.
drop index if exists tm_slot_uniq;
create unique index if not exists tm_slot_uniq
  on public.tournament_matches (tournament_id, bracket, coalesce(group_no, 0), round, slot);
create index if not exists tm_group_idx
  on public.tournament_matches (tournament_id, group_no);


-- Called after every settled result. Returns how many matches it created, so
-- the caller can tell "the next round just appeared" from "nothing was owed".
--
-- The old finish rule was "no matches left to play means the tournament is
-- over". That is wrong the moment generation becomes incremental: a Swiss
-- event between rounds, and a group event between the last group match and the
-- playoff draw, both have zero unplayed matches while being very much alive.
-- Formats that generate everything up front behave exactly as before.
create or replace function public.tournament_advance_stage(p_tournament uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  t        tournaments%rowtype;
  unplayed int;
begin
  select * into t from tournaments where id = p_tournament;
  if t.id is null or t.status <> 'running' then return 0; end if;

  select count(*) into unplayed
    from tournament_matches
   where tournament_id = p_tournament and status <> 'done';
  if unplayed > 0 then return 0; end if;   -- the current stage is still being played

  -- Swiss and group stages hook in here, in the migrations that add them.

  update tournaments
     set status = 'finished', finished_at = now(),
         champion_id = tournament_champion(p_tournament)
   where id = p_tournament;
  return 0;
end $function$;


-- Who actually won. This cannot stay "the winner of the highest round": a
-- Swiss event has no final, and a group event's last match sits in a playoff
-- bracket that may or may not be double elimination. It also has to skip
-- matches that were closed with no winner — byes with nobody in them, and
-- drawn group games.
create or replace function public.tournament_champion(p_tournament uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  t   tournaments%rowtype;
  win uuid;
begin
  select * into t from tournaments where id = p_tournament;

  if t.format = 'round_robin' then
    -- Most series won, then the widest game difference, then the seed. The
    -- group-stage migration replaces this with the full tiebreaker chain.
    select x.team_id into win from (
      select tt.id as team_id,
             count(*) filter (where m.winner_id = tt.id) as wins,
             coalesce(sum(case when m.team_a = tt.id then m.score_a - m.score_b
                               when m.team_b = tt.id then m.score_b - m.score_a end), 0) as diff,
             tt.seed
        from tournament_teams tt
        left join tournament_matches m
               on m.tournament_id = tt.tournament_id
              and m.status = 'done'
              and (m.team_a = tt.id or m.team_b = tt.id)
       where tt.tournament_id = p_tournament
       group by tt.id, tt.seed
       order by wins desc, diff desc, tt.seed
       limit 1) x;
    return win;
  end if;

  select winner_id into win
    from tournament_matches
   where tournament_id = p_tournament
     and bracket in ('grand_final','main')
     and status = 'done'
     and winner_id is not null
   order by case bracket when 'grand_final' then 0 else 1 end, round desc
   limit 1;
  return win;
end $function$;


-- ===========================================================================
-- 4. Settling a result, with the stage machine wired in.
--
-- The advisory lock is not decoration. Two captains can confirm the last two
-- matches of a round at the same instant; under READ COMMITTED each would
-- count the other's match as still unplayed, both would decide there was
-- nothing to generate, and the tournament would sit there with no matches
-- left and no next round — permanently, because nothing else ever calls the
-- stage machine. Serialising per tournament makes the second confirm see the
-- first one's result.
-- ===========================================================================
create or replace function public.tournament_confirm(p_match uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  m   tournament_matches%rowtype;
  win uuid; lose uuid;
begin
  select * into m from tournament_matches where id = p_match;
  if m.id is null then raise exception 'Match not found.'; end if;
  if m.status = 'done' then return; end if;
  -- Only ever reached through tournament_report, which has already checked the
  -- caller and parked a score. Refusing anything else means a future caller
  -- cannot accidentally settle a match nobody has reported.
  if m.status <> 'reported' then
    raise exception 'That result has not been reported yet.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(m.tournament_id::text, 0));

  win  := case when m.score_a > m.score_b then m.team_a
               when m.score_b > m.score_a then m.team_b end;
  lose := case when m.score_a > m.score_b then m.team_b
               when m.score_b > m.score_a then m.team_a end;

  update tournament_matches
     set status = 'done', winner_id = win, confirmed_by = auth.uid(), updated_at = now()
   where id = p_match;

  -- A drawn series has no winner and moves nobody. Only group play can end
  -- level; tournament_report refuses a draw anywhere a team has to advance.
  if win is not null then
    if m.next_match_id is not null then
      if m.next_is_a then update tournament_matches set team_a = win where id = m.next_match_id;
      else                update tournament_matches set team_b = win where id = m.next_match_id; end if;
      update tournament_matches set status = 'ready'
       where id = m.next_match_id and team_a is not null and team_b is not null and status = 'pending';
    end if;

    if m.loser_match_id is not null then
      if m.loser_is_a then update tournament_matches set team_a = lose where id = m.loser_match_id;
      else                 update tournament_matches set team_b = lose where id = m.loser_match_id; end if;
      update tournament_matches set status = 'ready'
       where id = m.loser_match_id and team_a is not null and team_b is not null and status = 'pending';
    end if;
  end if;

  perform tournament_resolve_byes(m.tournament_id);
  perform tournament_advance_stage(m.tournament_id);
end $function$;

revoke execute on function public.tournament_confirm(uuid) from public, authenticated;
grant  execute on function public.tournament_confirm(uuid) to service_role;
grant  execute on function public.tournament_champion(uuid) to authenticated, service_role;
-- Deliberately callable by any signed-in user: it only ever acts when the
-- current stage is completely finished, and it is the one thing that can
-- unstick an event whose organiser has gone to bed.
grant  execute on function public.tournament_advance_stage(uuid) to authenticated, service_role;
