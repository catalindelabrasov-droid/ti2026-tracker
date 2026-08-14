/* Delete the caller's own account, permanently.

   There is no support mailbox behind this site, so deletion has to work without
   a human in the loop — and it has to be impossible to fire at somebody else's
   account. Both come from the same rule: THIS FUNCTION ONLY EVER DELETES THE
   USER WHOSE TOKEN IT WAS GIVEN. It takes no user id, no email, no parameters
   of any kind. The caller proves who they are by holding a valid session, which
   they get only by clicking a link sent to their own inbox.

   verify_jwt stays FALSE in config.toml — not because this is public, but
   because the platform's own check answers a bare 401 with no body, and the
   page needs to tell "your link expired, request another" apart from "the
   server is down". So we verify the token ourselves, below, and nothing past
   that check runs without a real user. */

const URL_ = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors });

const svc = {
  apikey: SERVICE,
  Authorization: `Bearer ${SERVICE}`,
  "Content-Type": "application/json",
};

/* Tidy up leagues the deleted user was running.

   ORDER MATTERS, AND THIS RUNS **AFTER** THE ACCOUNT IS ALREADY GONE.
   Erasure is a right; it must not be blocked, or partially undone, by league
   bookkeeping. Doing it the other way round meant a failure here could leave
   somebody still registered but no longer running their own leagues, while the
   page told them nothing had happened. Now the worst case is a league that is
   briefly without an admin, which loses nobody any data and can be repaired.

   leagues.admin_id has no foreign key, so nothing here is enforced by the
   database — which is exactly why it is done explicitly.

   The deleted user's own league_members rows are already gone by now (those DO
   cascade), so "no members left" here genuinely means empty. */
async function rehomeLeagues(uid: string) {
  const rest = `${URL_}/rest/v1`;
  const out = { rehomed: 0, removed: 0, untouched: 0 };

  const ownedRes = await fetch(`${rest}/leagues?admin_id=eq.${uid}&select=id`, { headers: svc })
    .catch(() => null);
  if (!ownedRes || !ownedRes.ok) return out;
  const owned = await ownedRes.json().catch(() => null);
  if (!Array.isArray(owned) || !owned.length) return out;

  for (const lg of owned) {
    // Longest-standing remaining member inherits it.
    const heirRes = await fetch(
      `${rest}/league_members?league_id=eq.${lg.id}&select=user_id&order=joined_at.asc&limit=1`,
      { headers: svc },
    ).catch(() => null);

    /* A FAILED LOOKUP IS NOT AN EMPTY LEAGUE.
       This used to fall back to [] on any error, and [] took the delete branch —
       so one network blip could destroy a twelve-person league and every
       prediction in it because the owner left. When we cannot see who is in
       there, we touch nothing. */
    if (!heirRes || !heirRes.ok) { out.untouched++; continue; }
    const heirs = await heirRes.json().catch(() => null);
    if (!Array.isArray(heirs)) { out.untouched++; continue; }

    if (heirs.length && heirs[0]?.user_id) {
      const r = await fetch(`${rest}/leagues?id=eq.${lg.id}`, {
        method: "PATCH",
        headers: { ...svc, Prefer: "return=minimal" },
        body: JSON.stringify({ admin_id: heirs[0].user_id }),
      }).catch(() => null);
      // Count what actually happened, not what was attempted — the number goes
      // on screen.
      if (r && r.ok) out.rehomed++; else out.untouched++;
    } else {
      // Genuinely nobody left in it. An empty league helps no one and sits on a
      // join code.
      const r = await fetch(`${rest}/leagues?id=eq.${lg.id}`, { method: "DELETE", headers: svc })
        .catch(() => null);
      if (r && r.ok) out.removed++; else out.untouched++;
    }
  }
  return out;
}

/* What would this deletion take down with it?
   Counts only things OTHER people are in. A league you run alone, or a
   tournament nobody else entered, is yours to take with you. */
async function ownedThings(uid: string) {
  const rest = `${URL_}/rest/v1`;
  const count = async (path: string) => {
    const r = await fetch(`${rest}/${path}`, {
      headers: { ...svc, Prefer: "count=exact", Range: "0-0" },
    }).catch(() => null);
    if (!r || !r.ok) return -1;                       // unknown: treat as blocking
    const cr = r.headers.get("content-range") || "";  // "0-0/12"
    const n = Number(cr.split("/")[1]);
    return Number.isFinite(n) ? n : -1;
  };

  const leagueIds: string[] = await fetch(`${rest}/leagues?admin_id=eq.${uid}&select=id`, { headers: svc })
    .then((r) => (r.ok ? r.json() : null)).then((a) => Array.isArray(a) ? a.map((x: any) => x.id) : [])
    .catch(() => []);

  let sharedLeagues = 0;
  for (const id of leagueIds) {
    const others = await count(`league_members?league_id=eq.${id}&user_id=neq.${uid}&select=user_id`);
    if (others !== 0) sharedLeagues++;   // -1 (unknown) counts as shared, deliberately
  }

  const tournaments = await count(`tournaments?organiser_id=eq.${uid}&select=id`);
  const ladderTeams = await count(`ladder_teams?captain_id=eq.${uid}&select=id`);

  return {
    sharedLeagues,
    tournaments: tournaments < 0 ? 1 : tournaments,
    ladderTeams: ladderTeams < 0 ? 1 : ladderTeams,
    blocking: sharedLeagues + (tournaments < 0 ? 1 : tournaments) + (ladderTeams < 0 ? 1 : ladderTeams),
  };
}

/* DISABLED ON PURPOSE — do not remove this without reading the note.

   Deleting an account cascades far wider than the account: leagues.admin_id,
   tournaments.organiser_id, tournament_teams.captain_id and
   ladder_teams.captain_id are all ON DELETE CASCADE from auth.users, and
   leagues cascade onward into league_members, predictions and
   outcome_predictions. Twice in testing, deleting one owner destroyed a whole
   league and every member's picks with it.

   A guard that reads the tables first and then deletes is not good enough: the
   read and the delete are separate calls, and the version of that guard tested
   here did not stop it. The hand-over and the delete have to happen in ONE
   transaction — a SECURITY DEFINER function in the database — which is the fix
   being built. Until that lands this endpoint refuses everything, because a
   deletion route that quietly takes other people's data is worse than no
   deletion route at all.

   The page tells the user to email instead, so the right to erasure is still
   honoured; it is just not self-service for the moment. */
const ENABLED = false;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!ENABLED) return json({ error: "temporarily_unavailable" }, 503);

  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token || token === ANON) return json({ error: "not_signed_in" }, 401);

  // Ask the auth server who this token belongs to. A forged or expired token
  // dies right here, and this is the ONLY place the identity comes from.
  const who = await fetch(`${URL_}/auth/v1/user`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  });
  if (!who.ok) return json({ error: "link_expired" }, 401);

  const user = await who.json().catch(() => null);
  const uid = user?.id;
  if (!uid) return json({ error: "link_expired" }, 401);

  /* GUARD — deleting this account would take other people's data with it.

     leagues.admin_id, tournaments.organiser_id, tournament_teams.captain_id and
     ladder_teams.captain_id are ALL declared ON DELETE CASCADE from auth.users,
     and leagues cascade onwards into league_members, predictions and
     outcome_predictions. So removing the admin of a six-person league silently
     destroys that league and all six people's picks.

     Until the hand-over runs inside the same transaction as the delete, refuse
     rather than risk it. Erasure is a right, but it is this user's right — not a
     licence to erase everyone who joined their league. */
  const owns = await ownedThings(uid);
  if (owns.blocking > 0) {
    return json({ error: "owns_shared_content", owns }, 409);
  }

  // The account. Everything personal cascades from here: profile, league
  // memberships, predictions, outcome predictions, push subscriptions.
  let del: Response;
  try {
    del = await fetch(`${URL_}/auth/v1/admin/users/${uid}`, {
      method: "DELETE",
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    });
  } catch (e) {
    return json({ error: "delete_failed", detail: String(e) }, 500);
  }
  if (!del.ok) {
    // Nothing has been touched yet, so the page may honestly say so.
    return json({ error: "delete_failed", detail: await del.text().catch(() => "") }, 500);
  }

  // Past this line the account is gone and the request has succeeded. Anything
  // below is tidying, and must never turn a completed deletion into an error.
  let leagues = { rehomed: 0, removed: 0, untouched: 0 };
  try { leagues = await rehomeLeagues(uid); } catch (_e) { /* league left adminless; account is still deleted */ }

  return json({ ok: true, email: user?.email ?? null, leagues });
});
