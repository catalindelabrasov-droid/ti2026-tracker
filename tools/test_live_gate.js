/* A finished game must not be shown as live.
 *
 * Run: node tools/test_live_gate.js
 *
 * WHY THIS EXISTS
 *
 * On 16 Aug 2026 the front page showed two matches as LIVE that were already
 * over. The user spotted it, not us, and it was the THIRD time. The cause is
 * that OpenDota's /live does not reliably set deactivate_time when a game ends;
 * the row just stops updating. So "finished" and "the dump is lagging" are the
 * same observation, and live-matches tried to separate them with staleness
 * windows. Both ghosts sat 0 and 5 minutes behind the freshest row - inside
 * every window - so they passed.
 *
 * live-matches now asks Valve's GetLiveLeagueGames which match_ids are actually
 * on a server, and that decides liveness. This file replays the real 16 Aug
 * snapshot through the same filter logic.
 *
 * The fixture is the genuine data: match ids, team names, kill scores, game
 * times and last_update_time offsets are the ones observed in production.
 */
let fail = 0;
(async () => {
const ok = (cond, msg, extra) => {
  console.log((cond ? "  ok   " : "  FAIL ") + msg + (extra ? "   " + extra : ""));
  if (!cond) fail++;
};

/* The exact filter live-matches applies, kept in step with the function by the
   assertions below rather than by copying the whole file. */
function selectLive(rows, valveIds, opts) {
  const { newestStamp, snapshotUsable, STALE_RUNNING_SEC, STALE_DRAFT_SEC } = opts;
  const out = {};
  for (const g of rows) {
    if (g.deactivate_time) continue;
    if (valveIds) {
      if (!valveIds.has(String(g.match_id))) continue;
    } else {
      if (!snapshotUsable) continue;
      const age = newestStamp - (g.last_update_time || 0);
      const drafting = (g.game_time ?? 0) <= 0;
      const limit = drafting ? STALE_DRAFT_SEC : STALE_RUNNING_SEC;
      if (!g.last_update_time || age > limit) continue;
    }
    const pair = [String(g.team_name_radiant), String(g.team_name_dire)]
      .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)).join("|");
    const prev = out[pair];
    if (!prev || (g.match_id || 0) > (prev.match_id || 0)) out[pair] = g;
  }
  return Object.values(out);
}

const NEWEST = 1_786_900_000;          // freshest row in the snapshot
const OPTS = {
  newestStamp: NEWEST, snapshotUsable: true,
  STALE_RUNNING_SEC: 6 * 60, STALE_DRAFT_SEC: 25 * 60,
};

/* Production snapshot, 16 Aug 2026 ~06:45 UTC. The first two were OVER; Valve
   returned neither. The third and fourth were long dead and already filtered. */
const ROWS = [
  { match_id: 8948151326, team_name_radiant: "Team Resilience", team_name_dire: "Team Spirit",
    radiant_score: 50, dire_score: 21, game_time: 49 * 60, last_update_time: NEWEST - 5 * 60,
    league_id: 19719, deactivate_time: null },
  { match_id: 8948155771, team_name_radiant: "GamerLegion", team_name_dire: "Iron Wing",
    radiant_score: 15, dire_score: 25, game_time: 36 * 60, last_update_time: NEWEST,
    league_id: 19719, deactivate_time: null },
  { match_id: 8948100001, team_name_radiant: "Team Spirit", team_name_dire: "Team Resilience",
    radiant_score: 24, dire_score: 9, game_time: 28 * 60, last_update_time: NEWEST - 93 * 60,
    league_id: 19719, deactivate_time: null },
  { match_id: 8948000002, team_name_radiant: "Aurora Gaming", team_name_dire: "BoomBoys",
    radiant_score: 26, dire_score: 21, game_time: 37 * 60, last_update_time: NEWEST - 85 * 60,
    league_id: 19719, deactivate_time: null },
];

console.log("the bug: staleness alone lets the ghosts through");
const noGate = selectLive(ROWS, null, OPTS);
ok(noGate.length === 2,
   "without Valve, the two finished games are still reported live — the 16 Aug bug",
   noGate.map((g) => g.match_id).join(", "));

console.log("\nthe fix: Valve's list decides");
const valveSaysNothingLive = new Set();
const gated = selectLive(ROWS, valveSaysNothingLive, OPTS);
ok(gated.length === 0,
   "Valve returned no live games, so nothing is shown as live",
   String(gated.length));

console.log("\nand a genuinely live match is still shown");
const valveSaysOneLive = new Set(["8948155771"]);
const one = selectLive(ROWS, valveSaysOneLive, OPTS);
ok(one.length === 1 && String(one[0].match_id) === "8948155771",
   "the match Valve confirms is kept", one.map((g) => g.match_id).join(", "));

console.log("\nthe OTHER failure mode: a live match whose OpenDota row went quiet");
/* On 15 Aug four real matches were hidden because the dump lagged 11-14 min.
   Under the gate a stale row is kept when Valve says it is being played. */
const stale = [{ ...ROWS[0], match_id: 8948999999, last_update_time: NEWEST - 30 * 60 }];
ok(selectLive(stale, null, OPTS).length === 0,
   "staleness alone HIDES it — the 15 Aug bug", "");
ok(selectLive(stale, new Set(["8948999999"]), OPTS).length === 1,
   "the gate keeps it, because Valve says it is on a server", "");

console.log("\ndegrades rather than empties when Valve cannot be reached");
ok(selectLive(ROWS, null, OPTS).length === 2,
   "valveIds === null falls back to exactly the old behaviour", "");

console.log("\ndeactivate_time is still honoured when Valve does answer");
const ended = [{ ...ROWS[1], deactivate_time: 1786899000 }];
ok(selectLive(ended, new Set(["8948155771"]), OPTS).length === 0,
   "a row Valve still lists but Valve itself marked deactivated is dropped", "");

/* Everything above exercises a COPY of the filter. That proves the logic is
   right and proves nothing about the shipped function, so the checks below
   assert the gate is actually present in live-matches and ordered correctly.
   Without them, deleting the gate from production would leave this file green. */
console.log("\nthe shipped function actually has the gate");
const fs = require("fs");
const path = require("path");
const SRC = fs.readFileSync(
  path.join(path.dirname(__dirname), "supabase", "functions", "live-matches", "index.ts"), "utf8");

ok(/async function valveLiveIds\(\)/.test(SRC),
   "valveLiveIds() is defined", "");
ok(/GetLiveLeagueGames/.test(SRC),
   "it calls Valve's GetLiveLeagueGames", "");
ok(/const valveIds = await valveLiveIds\(\);/.test(SRC),
   "the live loop asks Valve before filtering", "");
ok(/if \(!valveIds\.has\(String\(g\.match_id\)\)\) continue;/.test(SRC),
   "a match absent from Valve's list is dropped", "");
ok(/if \(valveIds\) \{[\s\S]{0,900}\} else \{[\s\S]{0,600}STALE_RUNNING_SEC/.test(SRC),
   "the staleness heuristics survive as the fallback branch", "");
ok(SRC.indexOf("if (g.deactivate_time) continue;") < SRC.indexOf("if (valveIds) {"),
   "deactivate_time is still checked first", "");
ok(/STEAM_API_KEY/.test(SRC),
   "it reads the Steam key from the environment, not a literal", "");

/* Static checks cannot see a function that still exists but has been made to
   return null - the gate would then never engage and the ghosts would quietly
   come back. So run the REAL valveLiveIds() against a stubbed Valve. */
console.log("\nvalveLiveIds() actually parses Valve's payload");
{
  const body = SRC.match(/async function valveLiveIds\(\)[\s\S]*?\n\}/);
  ok(!!body, "the function body could be extracted", "");
  if (body) {
    const harness = `
      let STEAM_KEY = __KEY__, _valveIds = null;
      const STEAM_LIVE = "https://api.steampowered.com/IDOTA2Match_570/GetLiveLeagueGames/v1/";
      const VALVE_IDS_TTL = 20000, UA = {};
      ${body[0].replace(/: Promise<Set<string> \| null>/, "").replace(/: any/g, "")}
      return valveLiveIds;`;

    const withFetch = (payload, status = 200) => {
      global.fetch = async () => ({ ok: status === 200, status, json: async () => payload });
    };

    // 1. a normal answer becomes a Set of match ids
    withFetch({ result: { games: [{ match_id: 111 }, { match_id: 222 }] } });
    let fn = new Function(harness.replace("__KEY__", '"k"'))();
    let ids = await fn();
    ok(ids instanceof Set && ids.size === 2 && ids.has("111") && ids.has("222"),
       "two live games -> Set{'111','222'}", ids && [...ids].join(","));

    // 2. THE MUTANT THAT SURVIVED: it must not just hand back null
    ok(ids !== null, "it does not return null when Valve answered", "");

    // 3. no key -> null, so the caller falls back instead of emptying the page
    fn = new Function(harness.replace("__KEY__", '""'))();
    ok((await fn()) === null, "no Steam key -> null (caller keeps old behaviour)", "");

    // 4. a non-200 -> null rather than an empty Set, which would hide every match
    withFetch({}, 503);
    fn = new Function(harness.replace("__KEY__", '"k"'))();
    ok((await fn()) === null, "Valve 503 -> null, NOT an empty Set", "");

    // 5. a malformed body -> null for the same reason
    withFetch({ result: {} });
    fn = new Function(harness.replace("__KEY__", '"k"'))();
    ok((await fn()) === null, "missing result.games -> null", "");

    // 6. Valve genuinely reporting nothing live IS an empty Set, not null -
    //    that is the case that must hide the ghosts.
    withFetch({ result: { games: [] } });
    fn = new Function(harness.replace("__KEY__", '"k"'))();
    const empty = await fn();
    ok(empty instanceof Set && empty.size === 0,
       "nothing live -> empty Set (so every ghost is dropped)", String(empty && empty.size));
  }
}

console.log();
console.log(fail ? fail + " FAILURE(S)" : "all good");
  process.exit(fail ? 1 : 0);
})();