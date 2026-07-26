#!/usr/bin/env python3
"""
update_data.py — Auto-updates data.json for the TI 2026 tracker.

Pulls tournament data from the Liquipedia Dota 2 wiki and writes it into
data.json, which index.html reads. Designed to be run on a schedule
(e.g. via GitHub Actions) so the site stays current with no manual edits.

IMPORTANT — Liquipedia API etiquette (required, do not remove):
  * A descriptive User-Agent with contact info is MANDATORY.
  * Rate limit: parse/HTML actions max 1 request / 2 sec; be conservative.
  * Data is CC-BY-SA — keep the attribution shown in the site footer.
  Docs: https://liquipedia.net/api-terms-of-use

If Liquipedia changes its page layout the parsers below may need tweaks;
the script is written defensively so a parse failure for one section does
NOT wipe existing good data — it keeps the previous value for that section.
"""

import json
import os
import re
import sys
import time
import datetime
import urllib.request
import urllib.parse

# ---------------------------------------------------------------------------
# CONFIG — change CONTACT to your own email/URL before deploying.
# ---------------------------------------------------------------------------
CONTACT = os.environ.get("LIQUIPEDIA_CONTACT", "your-email@example.com")
USER_AGENT = f"TI2026-Tracker/1.0 ({CONTACT}) python-urllib"
API = "https://liquipedia.net/dota2/api.php"
PAGE = "The_International/2026"          # main tournament page
DATA_FILE = os.path.join(os.path.dirname(__file__), "data.json")
REQUEST_GAP = 2.2                        # seconds between requests (>2s rule)

# --- OpenDota (secondary source for live match results) -------------------
# OpenDota is a real REST/JSON API (https://docs.opendota.com), free up to
# 50k calls/month & 60 req/min. It complements Liquipedia: Liquipedia gives us
# the tournament STRUCTURE (prize ladder, bracket shape, qualifiers, logos,
# rosters); OpenDota gives us reliable live match RESULTS without scraping.
#
# OPENDOTA_LEAGUE_ID accepts a comma-separated list of league ids. Ids that
# appear in OPENDOTA_QUALIFIER_REGIONS are treated as regional qualifiers and
# their series are synthesized into qualifiers[].matches; every other id (the
# main event) only merges scores into existing bracket/grand-final matches.
# Until it's set, the OpenDota step is skipped cleanly.
OPENDOTA_API = "https://api.opendota.com/api"
OPENDOTA_LEAGUE_IDS = [s.strip() for s in
                       os.environ.get("OPENDOTA_LEAGUE_ID", "").replace(";", ",").split(",")
                       if s.strip()]
OPENDOTA_KEY = os.environ.get("OPENDOTA_API_KEY", "").strip()          # optional, higher limits

# OpenDota league id -> region name as it appears in data.json qualifiers[].
# TI 2026 regional qualifiers (OpenDota /leagues, verified 2026-07-26).
OPENDOTA_QUALIFIER_REGIONS = {
    "19890": "North America",
    "19891": "South America",
    "19892": "Europe",
    "19893": "China",
    "19894": "Southeast Asia",
}

# --- Supabase (league backend) ---------------------------------------------
# Finished results are upserted into the match_results table, which the
# league_leaderboard() RPC scores locked predictions against. The URL is the
# public project URL (same one shipped in index.html); the service-role key is
# secret and comes only from the environment (GitHub Action secret). Without
# the key the push step is skipped cleanly.
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://hqpynfzatnmwvlxdfhsw.supabase.co").strip().rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()

_last_request = 0.0


def _throttle():
    global _last_request
    wait = REQUEST_GAP - (time.time() - _last_request)
    if wait > 0:
        time.sleep(wait)
    _last_request = time.time()


def api_get(params):
    """Call the Liquipedia API with required headers and rate limiting."""
    _throttle()
    params = {**params, "format": "json"}
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept-Encoding": "gzip",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            import gzip
            raw = gzip.decompress(raw)
        return json.loads(raw.decode("utf-8"))


def get_wikitext(page):
    """Fetch raw wikitext for a page (revisions API — lighter than parse)."""
    data = api_get({
        "action": "query",
        "prop": "revisions",
        "rvprop": "content",
        "rvslots": "main",
        "titles": page,
        "redirects": 1,
    })
    pages = data.get("query", {}).get("pages", {})
    for _, p in pages.items():
        try:
            return p["revisions"][0]["slots"]["main"]["*"]
        except (KeyError, IndexError):
            return None
    return None


# ---------------------------------------------------------------------------
# Parsers. Each takes wikitext and returns a value, or None on failure so the
# caller can preserve previously-stored data.
# ---------------------------------------------------------------------------

def clean(s):
    if s is None:
        return None
    s = re.sub(r"\[\[(?:[^\]|]*\|)?([^\]]+)\]\]", r"\1", s)   # [[link|text]] -> text
    s = re.sub(r"\{\{[^}]*\}\}", "", s)                        # strip simple templates
    s = re.sub(r"'''?", "", s)                                # bold/italic
    s = re.sub(r"<[^>]+>", "", s)                             # html tags
    return s.strip()


def parse_prize_pool(wt):
    """Find the total prize pool figure, e.g. prizepool=$1,600,000."""
    m = re.search(r"prizepool(?:usd)?\s*=\s*\$?([\d,]+)", wt, re.I)
    if not m:
        return None
    return int(m.group(1).replace(",", ""))


def parse_prize_distribution(wt):
    """
    Parse {{prize pool ...}} rows of the form:
      |place=1st |usdprize=... |[teamtemplate]
    Returns list of {place, amount, team} or None.
    """
    rows = []
    # Match slot rows in the prize pool template
    for m in re.finditer(r"\|place=([^\|\n]+)\|.*?usdprize=([\d,]+)?(.*?)(?=\|place=|\}\})",
                         wt, re.I | re.S):
        place = clean(m.group(1))
        amt = m.group(2)
        amount = int(amt.replace(",", "")) if amt else None
        team_m = re.search(r"\{\{TeamOpponent\|([^|}\n]+)", m.group(3))
        team = clean(team_m.group(1)) if team_m else None
        rows.append({"place": place, "amount": amount, "team": team})
    return rows or None


def parse_teams(wt):
    """Collect participating team names from {{TeamCard}} / participant tables."""
    teams = []
    seen = set()
    for m in re.finditer(r"\{\{TeamCard\|([^|}\n]+)", wt):
        name = clean(m.group(1))
        if name and name.lower() not in seen:
            seen.add(name.lower())
            teams.append({"name": name, "region": None, "qualification": None})
    return teams or None


def resolve_logo_urls(filenames):
    """
    Resolve a batch of wiki "File:" titles to actual image URLs via the
    MediaWiki imageinfo API (one request for up to ~50 titles).

    Returns {title: url}. Missing/failed titles are simply absent.
    Liquipedia images are CC-BY-SA — keep the attribution shown in the footer.
    """
    out = {}
    titles = [t for t in filenames if t]
    if not titles:
        return out
    # API allows multiple titles per call (pipe-separated), max 50.
    for i in range(0, len(titles), 40):
        batch = titles[i:i + 40]
        try:
            data = api_get({
                "action": "query",
                "titles": "|".join(batch),
                "prop": "imageinfo",
                "iiprop": "url",
            })
        except Exception as e:
            print(f"  ! logo imageinfo batch failed: {e}", file=sys.stderr)
            continue
        pages = data.get("query", {}).get("pages", {})
        # The API may normalize titles; map normalized -> original.
        norm = {n["to"]: n["from"] for n in data.get("query", {}).get("normalized", [])}
        for _, p in pages.items():
            title = p.get("title")
            ii = p.get("imageinfo")
            if title and ii:
                url = ii[0].get("url")
                if url:
                    out[norm.get(title, title)] = url
    return out


def find_team_logo_filenames(team_names):
    """
    For each team, find the logo image filename referenced on its team page.

    Liquipedia team pages use an Infobox that sets an image/logo file (commonly
    via `image=` or `teamcardimage=` parameters, or a {{LogoDark}}/{{Team}}
    template). This reads each team's page wikitext and extracts the first
    plausible File name. Returns {team_name: "File:Something.png"}.

    NOTE: layouts vary; this is best-effort and skips teams it can't resolve.
    Rate-limited via api_get(); for ~16-20 teams this is a handful of requests.
    """
    result = {}
    img_param = re.compile(
        r"(?:image|logo|teamcardimage|imagedark|imagelight)\s*=\s*([^|\n}]+\.(?:png|svg|jpg|jpeg|webp))",
        re.I,
    )
    for name in team_names:
        try:
            page_wt = get_wikitext(name)
        except Exception as e:
            print(f"  ! could not load team page '{name}': {e}", file=sys.stderr)
            page_wt = None
        if not page_wt:
            continue
        m = img_param.search(page_wt)
        if m:
            fn = clean(m.group(1)).strip()
            if fn and not fn.lower().startswith("file:"):
                fn = "File:" + fn
            result[name] = fn
    return result


def attach_team_logos(teams):
    """
    Mutates the given list of team dicts, adding a `logo` URL to each where one
    can be resolved from Liquipedia. Safe: any failure just leaves logo unset,
    and the front end falls back to a generated initials badge.
    """
    if not teams:
        return teams
    names = [t["name"] for t in teams if t.get("name")]
    name_to_file = find_team_logo_filenames(names)
    url_by_file = resolve_logo_urls(list(name_to_file.values()))
    attached = 0
    for t in teams:
        fn = name_to_file.get(t.get("name"))
        if fn and url_by_file.get(fn):
            t["logo"] = url_by_file[fn]
            attached += 1
    print(f"  Resolved {attached}/{len(teams)} team logos from Liquipedia")
    return teams


# ---------------------------------------------------------------------------
# Main update routine
# ---------------------------------------------------------------------------

def load_current():
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save(data):
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, DATA_FILE)


def opendota_get(path):
    """GET an OpenDota endpoint, returning parsed JSON (or None on failure)."""
    url = f"{OPENDOTA_API}{path}"
    if OPENDOTA_KEY:
        url += ("&" if "?" in url else "?") + "api_key=" + urllib.parse.quote(OPENDOTA_KEY)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_opendota_league_games(league_id):
    """All game rows for one OpenDota league, or [] on any failure."""
    try:
        rows = opendota_get(f"/leagues/{league_id}/matches")
    except Exception as e:
        print(f"  ! OpenDota league {league_id} unreachable: {e}", file=sys.stderr)
        return []
    return rows if isinstance(rows, list) else []


def fetch_opendota_league_teams(league_id):
    """
    {team_id: {"name": ..., "logo": ...}} for one league's participants.
    Needed because /leagues/{id}/matches carries only team_ids (its
    radiant_team_name/dire_team_name fields come back null).
    """
    try:
        rows = opendota_get(f"/leagues/{league_id}/teams")
    except Exception as e:
        print(f"  ! OpenDota league {league_id} teams unreachable: {e}", file=sys.stderr)
        return {}
    out = {}
    for t in rows if isinstance(rows, list) else []:
        tid = t.get("team_id")
        name = (t.get("name") or "").strip()
        if tid and name:
            out[tid] = {"name": name, "logo": t.get("logo_url") or None}
    return out


_BEST_OF = {0: 1, 1: 3, 2: 5}  # OpenDota series_type -> Bo-N


def aggregate_series(rows, team_names):
    """
    Group OpenDota game rows (one row per GAME) into series.

    team_names maps team_id -> display name (from the league's /teams call);
    rows' own name fields are used when present, ids resolve the rest.

    Keyed by OpenDota's own series_id when present — that id is stable across
    runs, which matters because predictions and notifications key on the match
    ids we derive from it. Games without a series_id (Bo1s, older rows) fall
    back to team-pair + day, so two Bo1s between the same teams on different
    days stay separate.
    """
    series = {}
    for g in rows:
        rad = (g.get("radiant_team_name") or g.get("radiant_name") or "").strip() \
            or team_names.get(g.get("radiant_team_id"), "")
        dire = (g.get("dire_team_name") or g.get("dire_name") or "").strip() \
            or team_names.get(g.get("dire_team_id"), "")
        if not rad or not dire:
            continue
        a, b = sorted([rad, dire], key=str.lower)
        start = g.get("start_time") or 0
        sid = g.get("series_id") or 0
        key = str(sid) if sid else f"{a.lower()}-{b.lower()}-{start // 86400}"
        s = series.setdefault(key, {
            "sid": key, "a": a, "b": b, "sa": 0, "sb": 0,
            "best_of": _BEST_OF.get(g.get("series_type") or 0, 3),
            "start": start, "last": 0, "games": [],
        })
        if start:
            s["start"] = min(s["start"] or start, start)
        s["last"] = max(s["last"], start + (g.get("duration") or 0))
        if g.get("radiant_win") is None:
            continue
        winner = rad if g["radiant_win"] else dire
        if winner.lower() == s["a"].lower():
            s["sa"] += 1
        else:
            s["sb"] += 1
        # Per-game rows feed the league's first-game / reverse-sweep rules.
        s["games"].append({"winner": winner, "duration": g.get("duration"),
                           "start": start})
    out = list(series.values())
    for s in out:
        s["games"].sort(key=lambda x: x["start"] or 0)
    return out


def build_series_pair_map(rows, team_names):
    """
    Aggregate game rows into { "team_a_lower|team_b_lower": [series, ...] }.
    A LIST per pair, because the same two teams can meet more than once in
    one league (Swiss group stage + elimination + playoffs all share league
    19719) — the merge step picks the series closest in time to the match.
    """
    out = {}
    for s in aggregate_series(rows, team_names):
        out.setdefault(f"{s['a'].lower()}|{s['b'].lower()}", []).append(s)
    if out:
        print(f"  · OpenDota: aggregated {sum(len(v) for v in out.values())} main-event series.")
    return out


def _pick_series(candidates, scheduled_iso):
    """Choose the right series for a match when a team pair met repeatedly."""
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0]
    if scheduled_iso:
        try:
            ts = datetime.datetime.fromisoformat(scheduled_iso).timestamp()
            best = min(candidates, key=lambda s: abs((s["start"] or 0) - ts))
            # Only trust the time match within a generous window (36h);
            # otherwise this match's series probably hasn't been played yet.
            if abs((best["start"] or 0) - ts) <= 36 * 3600:
                return best
            return None
        except ValueError:
            pass
    return max(candidates, key=lambda s: s.get("start") or 0)


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")


# match_id -> [{game_no, winner, duration, start_time}], collected while
# OpenDota series are matched to matches; pushed to the league backend.
_GAMES_BY_MATCH = {}


def _record_games(match_id, series):
    games = series.get("games") or []
    if not games:
        return
    _GAMES_BY_MATCH[match_id] = [
        {"match_id": match_id, "game_no": i + 1, "winner": g["winner"],
         "duration": g.get("duration"),
         "start_time": datetime.datetime.fromtimestamp(
             g["start"], datetime.timezone.utc).isoformat() if g.get("start") else None}
        for i, g in enumerate(games)
    ]


def synth_qualifier_matches(league_id, rows, now_ts, team_names):
    """
    Build qualifiers[].matches entries from one qualifier league's OpenDota
    games. Ids look like "q19893-841923" (league + series id) and stay stable
    across runs so notifications and locked predictions keep tracking the same
    series.
    """
    matches = []
    for s in sorted(aggregate_series(rows, team_names), key=lambda x: x["start"]):
        need = s["best_of"] // 2 + 1
        clinched = max(s["sa"], s["sb"]) >= need
        recent = (now_ts - s["last"]) < 3 * 3600
        status = "completed" if clinched else ("live" if recent else "completed")
        _record_games(f"q{league_id}-{_slug(s['sid'])}", s)
        matches.append({
            "id": f"q{league_id}-{_slug(s['sid'])}",
            "bestOf": s["best_of"],
            "status": status,
            "scheduled": datetime.datetime.fromtimestamp(
                s["start"], datetime.timezone.utc).isoformat() if s["start"] else None,
            "teamA": {"name": s["a"], "score": s["sa"]},
            "teamB": {"name": s["b"], "score": s["sb"]},
        })
    return matches


def merge_opendota_qualifiers(data, per_league, now_ts):
    """
    Fill qualifiers[].matches (and teams/status) for every region whose
    OpenDota qualifier league returned games. Liquipedia stays authoritative
    for winners; OpenDota provides the live series list. Returns match count.

    per_league: {league_id: {"games": [...], "teams": {tid: {name, logo}}}}
    """
    count = 0
    quals = data.setdefault("qualifiers", [])
    by_region = {q.get("region"): q for q in quals}
    for lid, region in OPENDOTA_QUALIFIER_REGIONS.items():
        bundle = per_league.get(lid) or {}
        rows = bundle.get("games") or []
        if not rows:
            continue
        names = {tid: t["name"] for tid, t in (bundle.get("teams") or {}).items()}
        matches = synth_qualifier_matches(lid, rows, now_ts, names)
        if not matches:
            continue
        q = by_region.get(region)
        if q is None:
            q = {"region": region, "status": "upcoming", "winners": [], "slots": 2}
            quals.append(q)
            by_region[region] = q
        q["matches"] = matches
        # Prefer the league's full participant list; fall back to match teams.
        q["teams"] = sorted(names.values(), key=str.lower) if names else sorted(
            {m["teamA"]["name"] for m in matches} | {m["teamB"]["name"] for m in matches},
            key=str.lower)
        if any(m["status"] == "live" for m in matches):
            q["status"] = "live"
        elif q.get("status") in (None, "", "pending", "upcoming"):
            q["status"] = "live"  # games exist, no winner declared yet
        count += len(matches)
    return count


def run_opendota(data):
    """
    Fetch every configured OpenDota league and fold results into data:
    qualifier leagues -> synthesized qualifiers[].matches; main event ->
    score merge into existing bracket matches. Team logos OpenDota knows and
    Liquipedia hasn't provided yet are added to the top-level logos map.
    Returns (qual_matches, merged_scores).
    """
    if not OPENDOTA_LEAGUE_IDS:
        print("  · OpenDota league id not set — skipping results merge.")
        return (0, 0)
    _GAMES_BY_MATCH.clear()
    now_ts = int(time.time())
    per_league = {}
    for lid in OPENDOTA_LEAGUE_IDS:
        games = fetch_opendota_league_games(lid)
        teams = fetch_opendota_league_teams(lid) if games else {}
        per_league[lid] = {"games": games, "teams": teams}
        print(f"  · OpenDota league {lid}: {len(games)} games, {len(teams)} teams.")
    nq = merge_opendota_qualifiers(data, per_league, now_ts)
    main_games, main_names = [], {}
    for lid, bundle in per_league.items():
        if lid in OPENDOTA_QUALIFIER_REGIONS:
            continue
        main_games.extend(bundle["games"])
        main_names.update({tid: t["name"] for tid, t in bundle["teams"].items()})
    nb = merge_opendota_scores(data, build_series_pair_map(main_games, main_names))
    # Logos: only fill names Liquipedia hasn't resolved (it stays authoritative).
    logos = data.setdefault("logos", {})
    added = 0
    for bundle in per_league.values():
        for t in bundle["teams"].values():
            if t.get("logo") and t["name"] not in logos:
                logos[t["name"]] = t["logo"]
                added += 1
    if added:
        print(f"  · Added {added} team logo(s) from OpenDota.")
    return (nq, nb)


def _match_key(name_a, name_b):
    a, b = sorted([(name_a or "").strip(), (name_b or "").strip()], key=str.lower)
    return f"{a.lower()}|{b.lower()}"


def merge_opendota_scores(data, series):
    """
    Fill in/confirm match scores across qualifiers + bracket from the OpenDota
    series map. Only updates matches whose two named teams match a series and
    whose score isn't already set by Liquipedia (Liquipedia stays authoritative
    for structure; OpenDota backfills/confirms numbers). Returns count updated.
    """
    if not series:
        return 0
    updated = 0

    def apply(m):
        nonlocal updated
        ta = (m.get("teamA") or {}); tb = (m.get("teamB") or {})
        na, nb = ta.get("name"), tb.get("name")
        if not na or not nb or na == "TBD" or nb == "TBD":
            return
        s = _pick_series(series.get(_match_key(na, nb)), m.get("scheduled"))
        if not s:
            return
        if m.get("id"):
            _record_games(m["id"], s)
        # map series a/b back to this match's A/B by name
        if na.lower() == s["a"].lower():
            sa, sb = s["sa"], s["sb"]
        else:
            sa, sb = s["sb"], s["sa"]
        # only set if currently unset, or differs (live update)
        if ta.get("score") != sa or tb.get("score") != sb:
            ta["score"] = sa; tb["score"] = sb
            m["teamA"] = ta; m["teamB"] = tb
            if (sa + sb) > 0 and m.get("status") not in ("live", "completed"):
                m["status"] = "completed" if max(sa, sb) >= (m.get("bestOf", 3) // 2 + 1) else "live"
            updated += 1

    for q in data.get("qualifiers", []):
        for m in (q.get("matches") or []):
            apply(m)
    gs = data.get("groupStage") or {}
    for rnd in gs.get("rounds") or []:
        for m in (rnd.get("matches") or []):
            apply(m)
    for m in gs.get("eliminationMatches") or []:
        apply(m)
    br = data.get("bracket", {}) or {}
    for side in ("upper", "lower"):
        for rnd in (br.get("rounds", {}) or {}).get(side, []) or []:
            for m in (rnd.get("matches") or []):
                apply(m)
    if br.get("grandFinal"):
        apply(br["grandFinal"])
    return updated


# ---------------------------------------------------------------------------
# Liquipedia Match2 parsing — group stage, playoff bracket, participants.
#
# How TI pages actually store matches (verified against live pages 2026-07-26):
# - DURING an event the stage pages carry inline {{Match ...}} skeletons that
#   editors fill (opponents, per-{{Map}} winners, dates).
# - AFTER Liquipedia migrates an event, every slot collapses to a bare
#   {{Match}} stub and the data moves to standalone "Match:" namespace pages
#   (Match:ID_<containerid>_R01-M001 style) — we batch-fetch those as a
#   fallback. Even there, scores may live behind {{ApiMap|matchid=...}} with
#   no wikitext winner; OpenDota remains the score authority and merges by
#   team names. Liquipedia gives us STRUCTURE: pairings, rounds, dates.
# ---------------------------------------------------------------------------

GROUP_STAGE_PAGE = PAGE + "/Group_Stage"
MAIN_EVENT_PAGE = PAGE + "/Main_Event"

# Bracket/8U4L2DSL1D slot map (TI playoff bracket). Keys are NOT contiguous
# per side — R1M5 is LOWER bracket, R4M1 upper vs R4M2 lower. Hardcoded per
# the template's layout; do not derive side from the R number.
MAIN_BRACKET_SLOTS = {
    "R1M1": ("upper", 0, "Upper Bracket Quarterfinals"),
    "R1M2": ("upper", 0, "Upper Bracket Quarterfinals"),
    "R1M3": ("upper", 0, "Upper Bracket Quarterfinals"),
    "R1M4": ("upper", 0, "Upper Bracket Quarterfinals"),
    "R2M1": ("upper", 1, "Upper Bracket Semifinals"),
    "R2M2": ("upper", 1, "Upper Bracket Semifinals"),
    "R4M1": ("upper", 2, "Upper Bracket Final"),
    "R1M5": ("lower", 0, "Lower Bracket Round 1"),
    "R1M6": ("lower", 0, "Lower Bracket Round 1"),
    "R2M3": ("lower", 1, "Lower Bracket Quarterfinals"),
    "R2M4": ("lower", 1, "Lower Bracket Quarterfinals"),
    "R3M1": ("lower", 2, "Lower Bracket Semifinal"),
    "R4M2": ("lower", 3, "Lower Bracket Final"),
    "R5M1": ("final", 0, "Grand Final"),
}

# Rough tz-abbreviation offsets for Liquipedia date strings ("{{Abbr/CEST}}").
# Only needs to cover what TI pages realistically use.
_TZ_OFFSETS = {"UTC": 0, "GMT": 0, "CET": 1, "CEST": 2, "EET": 2, "EEST": 3,
               "MSK": 3, "SGT": 8, "CST": 8, "HKT": 8, "KST": 9, "JST": 9,
               "PST": -8, "PDT": -7, "EST": -5, "EDT": -4, "BST": 1}


def strip_html_comments(wt):
    return re.sub(r"<!--.*?-->", "", wt or "", flags=re.S)


def find_templates(wt, name_re):
    """
    Return [(name, full_template_text)] for every {{Name ...}} whose name
    matches name_re, extracted by brace counting — nested {{TeamOpponent}} /
    {{Map}} templates make non-greedy regex capture impossible.
    """
    out = []
    for m in re.finditer(r"\{\{(" + name_re + r")\s*(?=[|}\s])", wt):
        i, depth, n = m.start(), 0, len(wt)
        while i < n:
            if wt.startswith("{{", i):
                depth += 1
                i += 2
            elif wt.startswith("}}", i):
                depth -= 1
                i += 2
                if depth == 0:
                    break
            else:
                i += 1
        out.append((m.group(1), wt[m.start():i]))
    return out


def split_template_params(body):
    """
    Split one {{...}} template (braces included) into (positional, named),
    cutting only at pipes that sit at the template's own depth.
    """
    inner = body[2:-2] if body.startswith("{{") and body.endswith("}}") else body
    parts, cur, depth, i, n = [], [], 0, 0, len(inner)
    while i < n:
        if inner.startswith("{{", i):
            depth += 1; cur.append("{{"); i += 2; continue
        if inner.startswith("}}", i):
            depth -= 1; cur.append("}}"); i += 2; continue
        ch = inner[i]
        if ch == "|" and depth == 0:
            parts.append("".join(cur)); cur = []
        else:
            cur.append(ch)
        i += 1
    parts.append("".join(cur))
    positional, named = [], {}
    for p in parts[1:]:  # parts[0] is the template name
        m = re.match(r"^\s*([A-Za-z][\w ]*?)\s*=(.*)$", p, re.S)
        if m:
            named[m.group(1).strip()] = m.group(2).strip()
        elif p.strip():
            positional.append(p.strip())
    return positional, named


def _liqui_date_to_iso(raw):
    """'June 24, 2026 - 19:00 {{Abbr/CEST}}' -> ISO string, or None."""
    if not raw or not raw.strip():
        return None
    tz_m = re.search(r"\{\{[Aa]bbr/(\w+)\}\}", raw)
    offset = _TZ_OFFSETS.get(tz_m.group(1).upper(), 0) if tz_m else 0
    s = re.sub(r"\{\{[^}]*\}\}", "", raw).replace(" - ", " ").strip()
    for fmt in ("%B %d, %Y %H:%M", "%B %d, %Y", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            dt = datetime.datetime.strptime(s, fmt)
            tz = datetime.timezone(datetime.timedelta(hours=offset))
            return dt.replace(tzinfo=tz).isoformat()
        except ValueError:
            continue
    return None


def parse_match_block(body):
    """
    Parse one {{Match ...}} / {{MatchPage ...}} into
    {teamA, teamB, scoreA, scoreB, finished, played, date_iso, best_of}
    or None for a bare data-less stub.
    """
    positional, p = split_template_params(body)
    if not p and not positional:
        return None  # {{Match}} stub — data lives on a Match: page / LPDB

    def opponent(key):
        ts = find_templates(p.get(key, ""), "TeamOpponent")
        if not ts:
            return "", None
        po, pn = split_template_params(ts[0][1])
        name = clean(po[0]).strip() if po else ""
        if name.upper() == "TBD":
            name = ""
        return name, (pn.get("score") or "").strip() or None

    a_name, a_score = opponent("opponent1")
    b_name, b_score = opponent("opponent2")

    map_keys = sorted(k for k in p if re.fullmatch(r"map\d+", k))
    bo_param = (p.get("bestof") or "").strip()
    best_of = int(bo_param) if bo_param.isdigit() else (5 if len(map_keys) >= 5 else 3)

    w1 = w2 = 0
    for k in map_keys:
        ts = find_templates(p[k], "Map|ApiMap")
        if not ts:
            continue
        _, mp = split_template_params(ts[0][1])
        wv = (mp.get("winner") or "").strip()
        if wv == "1":
            w1 += 1
        elif wv == "2":
            w2 += 1

    def to_int(s):
        try:
            return int(s)
        except (TypeError, ValueError):
            return None

    sa, sb = to_int(a_score), to_int(b_score)
    if sa is None or sb is None:
        sa, sb = w1, w2

    need = best_of // 2 + 1
    finished = ((p.get("finished") or "").strip().lower() in ("true", "1")
                or (p.get("winner") or "").strip() in ("1", "2")
                or max(sa, sb) >= need)
    # Forfeit/walkover markers
    if (a_score or "").upper() in ("W",) or (b_score or "").upper() in ("FF", "L", "DQ"):
        sa, sb, finished = need, 0, True
    elif (b_score or "").upper() in ("W",) or (a_score or "").upper() in ("FF", "L", "DQ"):
        sa, sb, finished = 0, need, True

    return {
        "teamA": a_name, "teamB": b_name, "scoreA": sa, "scoreB": sb,
        "finished": finished, "played": w1 + w2,
        "date_iso": _liqui_date_to_iso(p.get("date")), "best_of": best_of,
    }


def parse_stage_containers(wt):
    """
    All {{Matchlist}} and {{Bracket}} containers on a stage page.
    Returns (matchlists, brackets) where each entry is
    {id, title/type, entries: [(slotkey, match_template_text_or_None)]}.
    """
    wt = strip_html_comments(wt)
    matchlists, brackets = [], []
    for name, body in find_templates(wt, "Matchlist|Bracket"):
        po, p = split_template_params(body)
        slot_re = r"M\d+" if name == "Matchlist" else r"R\d+M\d+"
        entries = []
        for k, v in p.items():
            if re.fullmatch(slot_re, k):
                ts = find_templates(v, "Match")
                block = ts[0][1] if ts else None
                entries.append((k, block))
        if name == "Matchlist":
            m = re.search(r"(\d+)", p.get("title") or p.get("matchsection") or "")
            matchlists.append({"id": (p.get("id") or "").strip(),
                               "round": int(m.group(1)) if m else len(matchlists) + 1,
                               "entries": entries})
        else:
            brackets.append({"id": (p.get("id") or "").strip(),
                             "type": po[0] if po else "",
                             "entries": entries})
    matchlists.sort(key=lambda r: r["round"])
    return matchlists, brackets


def fetch_match_pages(container_id, keys):
    """
    Batch-fetch standalone Match: pages for stub slots (one API call per 40
    titles — polite). Returns {slotkey: match_template_text}.
    """
    def page_suffix(k):
        m = re.fullmatch(r"R(\d+)M(\d+)", k)
        if m:
            return f"R{int(m.group(1)):02d}-M{int(m.group(2)):03d}"
        m = re.fullmatch(r"M(\d+)", k)
        if m:
            return f"M{int(m.group(1)):03d}"
        return k

    title_to_key = {f"Match:ID_{container_id}_{page_suffix(k)}": k for k in keys}
    out = {}
    titles = list(title_to_key)
    for i in range(0, len(titles), 40):
        batch = titles[i:i + 40]
        try:
            data = api_get({"action": "query", "prop": "revisions",
                            "rvprop": "content", "rvslots": "main",
                            "titles": "|".join(batch)})
        except Exception as e:
            print(f"  ! Match-page batch failed: {e}", file=sys.stderr)
            continue
        for _, pg in data.get("query", {}).get("pages", {}).items():
            title = (pg.get("title") or "").replace(" ", "_")
            try:
                wt = pg["revisions"][0]["slots"]["main"]["*"]
            except (KeyError, IndexError, TypeError):
                continue
            key = title_to_key.get(title)
            if key:
                ts = find_templates(wt, "MatchPage|Match")
                if ts:
                    out[key] = ts[0][1]
    if out:
        print(f"  · Fetched {len(out)} standalone match page(s) for {container_id}.")
    return out


def _build_match(mid, block, page_block, best_default, prev_by_id):
    """
    Turn parsed wikitext (inline block, else Match: page block) into the
    data.json match shape. Preserves previously-known scores when Liquipedia
    has none yet (OpenDota re-merges each run anyway).
    """
    parsed = parse_match_block(block) if block else None
    if parsed is None and page_block:
        parsed = parse_match_block(page_block)
    prev = prev_by_id.get(mid) or {}
    prev_a = (prev.get("teamA") or {})
    prev_b = (prev.get("teamB") or {})

    name_a = (parsed or {}).get("teamA") or prev_a.get("name") or "TBD"
    name_b = (parsed or {}).get("teamB") or prev_b.get("name") or "TBD"
    if name_a == "TBD" or name_b == "TBD":
        sa = sb = None
        status = "upcoming"
    elif parsed and (parsed["finished"] or parsed["played"] > 0
                     or parsed["scoreA"] or parsed["scoreB"]):
        sa, sb = parsed["scoreA"], parsed["scoreB"]
        status = "completed" if parsed["finished"] else "live"
    elif isinstance(prev_a.get("score"), int) or isinstance(prev_b.get("score"), int):
        sa, sb = prev_a.get("score"), prev_b.get("score")
        status = prev.get("status") or "upcoming"
    else:
        sa = sb = None
        status = "upcoming"

    out = {
        "id": mid,
        "bestOf": (parsed or {}).get("best_of") or prev.get("bestOf") or best_default,
        "status": status,
        "scheduled": (parsed or {}).get("date_iso") or prev.get("scheduled"),
        "teamA": {"name": name_a, "score": sa},
        "teamB": {"name": name_b, "score": sb},
    }
    if prev.get("streamUrl"):
        out["streamUrl"] = prev["streamUrl"]
    return out


def _prev_matches_by_id(*collections):
    out = {}
    for coll in collections:
        for m in coll or []:
            if isinstance(m, dict) and m.get("id"):
                out[m["id"]] = m
    return out


def _needs_page_fetch(entries, prev_by_id, id_fn):
    """Stub slots whose match we don't already have as completed."""
    keys = []
    for key, block in entries:
        if block is not None and parse_match_block(block) is not None:
            continue  # inline data exists
        prev = prev_by_id.get(id_fn(key)) or {}
        if prev.get("status") == "completed":
            continue  # final result already known — result never changes
        keys.append(key)
    return keys


def compute_group_standings(rounds):
    """W-L per team from decided group matches, sorted for the Swiss table."""
    rec = {}
    for rnd in rounds:
        for m in rnd.get("matches") or []:
            a, b = m["teamA"]["name"], m["teamB"]["name"]
            sa, sb = m["teamA"].get("score"), m["teamB"].get("score")
            for t in (a, b):
                if t and t != "TBD":
                    rec.setdefault(t, [0, 0])
            if (m.get("status") == "completed" and isinstance(sa, int)
                    and isinstance(sb, int) and sa != sb):
                w, l = (a, b) if sa > sb else (b, a)
                rec[w][0] += 1
                rec[l][1] += 1
    rows = [{"team": t, "wins": wl[0], "losses": wl[1]} for t, wl in rec.items()]
    rows.sort(key=lambda r: (-r["wins"], r["losses"], r["team"].lower()))
    return rows


def update_stages_from_liquipedia(data):
    """
    Refresh groupStage (rounds + standings + elimination round) and the
    playoff bracket from the Liquipedia stage subpages. Returns
    (group_matches, bracket_matches) counts of matches carrying real data.
    """
    n_gs = n_br = 0

    # ---- Group stage (Swiss rounds + elimination bracket) ----
    try:
        gs_wt = get_wikitext(GROUP_STAGE_PAGE)
    except Exception as e:
        print(f"  ! Group Stage page unreachable: {e}", file=sys.stderr)
        gs_wt = None
    if gs_wt:
        matchlists, brackets = parse_stage_containers(gs_wt)
        gs = data.setdefault("groupStage", {})
        prev = _prev_matches_by_id(
            *[r.get("matches") for r in gs.get("rounds") or []],
            gs.get("eliminationMatches"))
        rounds_out = []
        for ml in matchlists:
            def gid(key, _r=ml["round"]):
                return f"gs-r{_r}-{key.lower()}"
            pages = {}
            stub_keys = _needs_page_fetch(ml["entries"], prev, gid)
            if ml["id"] and stub_keys and any(
                    b is None or parse_match_block(b) is None
                    for _, b in ml["entries"]):
                pages = fetch_match_pages(ml["id"], stub_keys)
            matches = []
            for key, block in sorted(ml["entries"],
                                     key=lambda kv: int(kv[0][1:])):
                m = _build_match(gid(key), block, pages.get(key), 3, prev)
                matches.append(m)
                if m["teamA"]["name"] != "TBD":
                    n_gs += 1
            rounds_out.append({"name": f"Round {ml['round']}",
                               "matches": matches})
        if rounds_out:
            gs["rounds"] = rounds_out
            standings = compute_group_standings(rounds_out)
            if standings:
                gs["standings"] = standings
        # Elimination round (3-2 vs 2-3 for the last playoff spots)
        for br in brackets:
            if "8U4L2DSL1D" in br["type"]:
                continue  # that's the playoff bracket, lives on Main Event page
            def eid(key):
                return f"el-{key.lower()}"
            pages = {}
            stub_keys = _needs_page_fetch(br["entries"], prev, eid)
            if br["id"] and stub_keys and any(
                    b is None or parse_match_block(b) is None
                    for _, b in br["entries"]):
                pages = fetch_match_pages(br["id"], stub_keys)
            elim = []
            for key, block in sorted(br["entries"]):
                m = _build_match(eid(key), block, pages.get(key), 3, prev)
                elim.append(m)
                if m["teamA"]["name"] != "TBD":
                    n_gs += 1
            if elim:
                gs["eliminationMatches"] = elim

    # ---- Playoff bracket ----
    try:
        me_wt = get_wikitext(MAIN_EVENT_PAGE)
    except Exception as e:
        print(f"  ! Main Event page unreachable: {e}", file=sys.stderr)
        me_wt = None
    if me_wt:
        _, brackets = parse_stage_containers(me_wt)
        main_br = next((b for b in brackets if "8U4L2DSL1D" in b["type"]),
                       None)
        if main_br:
            br_data = data.setdefault("bracket", {})
            rounds_data = br_data.setdefault("rounds", {})
            prev = _prev_matches_by_id(
                *[r.get("matches") for r in rounds_data.get("upper") or []],
                *[r.get("matches") for r in rounds_data.get("lower") or []],
                [br_data.get("grandFinal")] if br_data.get("grandFinal") else [])

            def bid(key):
                return f"me-{key.lower()}"
            pages = {}
            stub_keys = _needs_page_fetch(main_br["entries"], prev, bid)
            if main_br["id"] and stub_keys and any(
                    b is None or parse_match_block(b) is None
                    for _, b in main_br["entries"]):
                pages = fetch_match_pages(main_br["id"], stub_keys)

            sides = {"upper": {}, "lower": {}}
            grand_final = None
            for key, block in main_br["entries"]:
                slot = MAIN_BRACKET_SLOTS.get(key)
                if not slot:
                    continue
                side, rnd_idx, rnd_name = slot
                best = 5 if side == "final" else 3
                m = _build_match(bid(key), block, pages.get(key), best, prev)
                if m["teamA"]["name"] != "TBD":
                    n_br += 1
                if side == "final":
                    grand_final = m
                else:
                    sides[side].setdefault(rnd_idx, {"name": rnd_name,
                                                     "matches": []})
                    sides[side][rnd_idx]["matches"].append(m)
            for side in ("upper", "lower"):
                if sides[side]:
                    rounds_data[side] = [sides[side][i]
                                         for i in sorted(sides[side])]
            if grand_final:
                br_data["grandFinal"] = grand_final
            br_data.setdefault(
                "format", "Double elimination — top 8 from the group stage")

    return n_gs, n_br


def parse_participants(wt):
    """
    The main page's {{TeamParticipants}} block: 16 teams with rosters
    ({{Person|role=N|Nick}}) and qualification info. Returns
    (teams_list_or_None, {region: [qualified team names]}).
    """
    roles = {"1": "Carry", "2": "Mid", "3": "Offlane",
             "4": "Support", "5": "Hard Support"}
    blocks = find_templates(strip_html_comments(wt), "TeamParticipants")
    if not blocks:
        return None, {}
    positional, _ = split_template_params(blocks[0][1])
    teams, region_winners = [], {}
    for chunk in positional:
        ts = find_templates(chunk, "Opponent")
        if not ts:
            continue
        po, pn = split_template_params(ts[0][1])
        if not po:
            continue
        name = clean(po[0].splitlines()[0]).strip()
        if not name:
            continue
        team = {"name": name, "region": None, "qualification": None}
        players, coaches = [], []
        for pm in re.finditer(r"\{\{Person\|([^{}]*)\}\}", pn.get("players", "")):
            parts = [x.strip() for x in pm.group(1).split("|")]
            role = next((x.split("=", 1)[1] for x in parts
                         if x.startswith("role=")), "")
            ign = next((x for x in parts if x and "=" not in x), None)
            if not ign:
                continue
            if role == "coach":
                coaches.append(ign)  # teams may list more than one coach
            else:
                players.append({"ign": ign, "role": roles.get(role, "Player")})
        if players:
            team["players"] = players
        if coaches:
            team["coach"] = " & ".join(coaches)
        qm = re.search(r"\{\{Qualification\|([^{}]*)\}\}",
                       pn.get("qualification", ""))
        if qm:
            qp = dict(x.split("=", 1) for x in qm.group(1).split("|")
                      if "=" in x)
            if qp.get("method") == "invite":
                team["qualification"] = "Direct Invite"
            elif qp.get("method") == "qual":
                region = (qp.get("text")
                          or (qp.get("page") or "").strip("/")).strip()
                team["qualification"] = "Regional Qualifier"
                team["region"] = region or None
                if region:
                    region_winners.setdefault(region, []).append(name)
        teams.append(team)
    return (teams or None), region_winners


# ---------------------------------------------------------------------------
# League backend: push finished results to Supabase match_results.
# The league_leaderboard() RPC scores locked predictions against this table,
# so without these rows every leaderboard would stay at zero.
# ---------------------------------------------------------------------------

def collect_completed_results(data):
    """
    Every decided match in data.json as {match_id, winner, score_a, score_b}.
    Only clinched series count (max score reaches the Bo-N threshold) — a
    stale 1-1 Bo3 has no winner and must not be scored.
    """
    rows = []

    def take(m):
        if not isinstance(m, dict) or m.get("status") != "completed" or not m.get("id"):
            return
        ta, tb = m.get("teamA") or {}, m.get("teamB") or {}
        na, nb = ta.get("name"), tb.get("name")
        sa, sb = ta.get("score"), tb.get("score")
        if not na or not nb or na == "TBD" or nb == "TBD":
            return
        if not isinstance(sa, int) or not isinstance(sb, int) or sa == sb:
            return
        if max(sa, sb) < ((m.get("bestOf") or 3) // 2 + 1):
            return
        rows.append({"match_id": m["id"], "winner": na if sa > sb else nb,
                     "score_a": sa, "score_b": sb})

    for q in data.get("qualifiers") or []:
        for m in q.get("matches") or []:
            take(m)
    gs = data.get("groupStage") or {}
    for rnd in gs.get("rounds") or []:
        for m in rnd.get("matches") or []:
            take(m)
    for m in gs.get("eliminationMatches") or []:
        take(m)
    br = data.get("bracket") or {}
    for side in ("upper", "lower"):
        for rnd in (br.get("rounds") or {}).get(side) or []:
            for m in rnd.get("matches") or []:
                take(m)
    if br.get("grandFinal"):
        take(br["grandFinal"])
    return rows


# ---------------------------------------------------------------------------
# World ranking + tournament tiers (datdota -> Supabase).
#
# datdota publishes a curated Glicko-2 for the ~35 teams that actually matter.
# OpenDota's own team rating is a raw Elo that rewards match volume: on
# 2026-07-26 its top 10 contained defunct orgs (VGJ Storm, Team NP), academy
# squads (Aurora.1xBet) and grinders — not a ranking a Dota player would
# recognise. So datdota drives the ladder and OpenDota supplies names/logos.
#
# This lives in the Action rather than the Edge Function because datdota's
# Cloudflare 403s Supabase's egress by IP (verified from the deployed runtime).
# ---------------------------------------------------------------------------

DATDOTA_API = "https://api.datdota.com/api"
# A non-browser User-Agent is refused outright.
DATDOTA_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://www.datdota.com/",
}


def datdota_get(path):
    """GET a datdota endpoint. Returns parsed JSON or None (never raises)."""
    req = urllib.request.Request(DATDOTA_API + path, headers=DATDOTA_HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            ctype = resp.headers.get("Content-Type") or ""
            if "json" not in ctype.lower():
                print(f"  ! datdota{path}: non-JSON response ({ctype})", file=sys.stderr)
                return None
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"  ! datdota{path} unreachable: {e}", file=sys.stderr)
        return None


def _iso(v):
    return v or None


def push_world_ratings():
    """
    Refresh team_ratings + league_tiers from datdota. Skips cleanly without the
    service key, and leaves the previous rows in place on any failure.
    """
    if not SUPABASE_SERVICE_ROLE_KEY:
        print("  · Supabase service key not set — skipping world ratings.")
        return 0

    ratings = datdota_get("/ratings")
    rows = (ratings or {}).get("data")
    n_teams = 0
    if isinstance(rows, list) and rows:
        out = []
        for r in rows:
            g = r.get("glicko2") or {}
            # The legacy `glicko` block is all-null upstream; only glicko2 is real.
            if g.get("rating") is None or not r.get("valveId"):
                continue
            out.append({
                "valve_id": r["valveId"],
                "name": r.get("teamName"),
                "glicko": round(g["rating"]),
                "glicko_prev": round(g["ratingSevenDaysAgo"]) if g.get("ratingSevenDaysAgo") is not None else None,
                "rd": round(g["phi"]) if g.get("phi") is not None else None,
                "region": r.get("region"),
                "as_of": _iso(r.get("glickoRatingDate")),
            })
        if out:
            _supabase_upsert("team_ratings", "valve_id", out)
            n_teams = len(out)
    else:
        print("  · datdota ratings unavailable — keeping the stored ranking.")

    time.sleep(3.2)   # datdota asks for >= 3s between requests

    leagues = datdota_get("/leagues")
    lrows = (leagues or {}).get("data")
    n_leagues = 0
    if isinstance(lrows, list) and lrows:
        out = []
        for l in lrows:
            tier = (l.get("tier") or {}).get("name")
            if not l.get("leagueId") or not tier:
                continue
            out.append({
                "league_id": l["leagueId"],
                "name": l.get("name"),
                "tier": tier,
                "first_game": _iso(l.get("first")),
                "last_game": _iso(l.get("last")),
                "games": l.get("count") or 0,
                "tags": l.get("tags") or [],
            })
        if out:
            _supabase_upsert("league_tiers", "league_id", out)
            n_leagues = len(out)
    else:
        print("  · datdota leagues unavailable — keeping the stored tiers.")

    if n_teams or n_leagues:
        print(f"  · World ranking: {n_teams} rated team(s), {n_leagues} tiered league(s).")
    return n_teams


def _stage_of(match_id):
    if match_id.startswith("q"):
        return "qualifier"
    if match_id.startswith("gs-"):
        return "group"
    if match_id.startswith("el-"):
        return "elimination"
    if match_id.startswith("me-"):
        return "playoffs"
    return "other"


def collect_all_matches(data):
    """
    Every known match as a `matches` row. The league backend needs these for
    participants (outcome resolution reads team names from here) and for the
    schedule the server-side lock deadline is enforced against.
    """
    rows = []

    def take(m):
        if not isinstance(m, dict) or not m.get("id"):
            return
        ta, tb = m.get("teamA") or {}, m.get("teamB") or {}
        rows.append({
            "match_id": m["id"],
            "team_a": ta.get("name"), "team_b": tb.get("name"),
            "best_of": m.get("bestOf") or 3,
            "scheduled_at": m.get("scheduled"),
            "stage": _stage_of(m["id"]),
            "status": m.get("status") or "upcoming",
        })

    for q in data.get("qualifiers") or []:
        for m in q.get("matches") or []:
            take(m)
    gs = data.get("groupStage") or {}
    for rnd in gs.get("rounds") or []:
        for m in rnd.get("matches") or []:
            take(m)
    for m in gs.get("eliminationMatches") or []:
        take(m)
    br = data.get("bracket") or {}
    for side in ("upper", "lower"):
        for rnd in (br.get("rounds") or {}).get(side) or []:
            for m in rnd.get("matches") or []:
                take(m)
    if br.get("grandFinal"):
        take(br["grandFinal"])
    return rows


def _supabase_upsert(table, conflict, rows):
    """Upsert rows into a Supabase table via PostgREST, in batches."""
    total = 0
    for i in range(0, len(rows), 500):
        batch = rows[i:i + 500]
        req = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/{table}?on_conflict={conflict}",
            data=json.dumps(batch).encode("utf-8"),
            headers={
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates,return=minimal",
            },
            method="POST")
        with urllib.request.urlopen(req, timeout=30):
            total += len(batch)
    return total


def push_league_backend(data):
    """
    Feed the prediction league: the schedule/participants (`matches`), the
    per-game rows (`match_games`) the first-game and reverse-sweep rules need,
    and the decided results (`match_results`) the leaderboard scores against.
    Skips cleanly when the service-role key isn't set (e.g. local runs).
    """
    if not SUPABASE_SERVICE_ROLE_KEY:
        print("  · Supabase service key not set — skipping league backend push.")
        return 0

    matches = collect_all_matches(data)
    if matches:
        _supabase_upsert("matches", "match_id", matches)

    games = [g for rows in _GAMES_BY_MATCH.values() for g in rows]
    if games:
        _supabase_upsert("match_games", "match_id,game_no", games)

    results = collect_completed_results(data)
    if results:
        _supabase_upsert("match_results", "match_id", results)

    print(f"  · League backend: {len(matches)} match(es), {len(games)} game(s), "
          f"{len(results)} result(s).")

    # The Dota hub's world ranking / tournament tiers (independent of the league).
    try:
        push_world_ratings()
    except Exception as e:
        print(f"  ! World ratings push failed: {e}", file=sys.stderr)
    return len(results)


def main():
    print(f"[{datetime.datetime.now(datetime.timezone.utc).isoformat()}] Updating TI 2026 data…")
    data = load_current()

    try:
        wt = get_wikitext(PAGE)
    except Exception as e:
        print(f"  ! Could not reach Liquipedia: {e}", file=sys.stderr)
        # Liquipedia is down, but OpenDota is an independent source — still try
        # to refresh live scores so the site keeps updating.
        try:
            nq, nb = run_opendota(data)
            if nq or nb:
                print(f"  · OpenDota updated {nq} qualifier match(es) + {nb} score(s) despite Liquipedia outage.")
        except Exception as e2:
            print(f"  ! OpenDota merge failed: {e2}", file=sys.stderr)
        data["meta"]["lastUpdated"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        save(data)
        try:
            push_league_backend(data)
        except Exception as e2:
            print(f"  ! League backend push failed: {e2}", file=sys.stderr)
        return 0

    if not wt:
        print("  ! No wikitext returned; keeping existing data.", file=sys.stderr)
        return 0

    changed = []

    # Prize pool total
    pp = parse_prize_pool(wt)
    if pp:
        data["prizePool"]["total"] = pp
        data["meta"]["basePrizePool"] = pp
        changed.append("prizePool.total")

    # Prize distribution
    dist = parse_prize_distribution(wt)
    if dist:
        data["prizePool"]["distribution"] = dist
        changed.append("prizePool.distribution")

    # Teams, rosters and qualifier winners — the participants table on the
    # main page carries all three ({{Opponent|Name|players=...{{Person}}...
    # |qualification={{Qualification|method=qual|text=Europe|placement=1-2}}}).
    teams, region_winners = parse_participants(wt)
    if not teams:
        teams = parse_teams(wt)  # legacy {{TeamCard}} fallback
    if teams:
        attach_team_logos(teams)  # adds a `logo` URL where resolvable
        data["teams"] = teams
        changed.append("teams")
        # Also expose a top-level name->logo map so the front end can show logos
        # for teams referenced only by name (e.g. per-region qualifier winners,
        # bracket opponents) without duplicating the URL on every reference.
        logos = {t["name"]: t["logo"] for t in teams if t.get("logo")}
        if logos:
            data["logos"] = {**(data.get("logos") or {}), **logos}
            changed.append("logos")

    # Region winners: mark qualifiers completed once the main page lists the
    # qualified teams (matches[] stay OpenDota-synthesized with stable ids).
    if region_winners:
        marked = 0
        for q in data.get("qualifiers", []):
            winners = region_winners.get(q.get("region"))
            if winners:
                q["winners"] = winners
                q["status"] = "completed"
                marked += 1
        if marked:
            changed.append(f"qualifierWinners({marked})")

    # Group stage + playoff bracket from the stage subpages (Match2).
    try:
        n_gs, n_br = update_stages_from_liquipedia(data)
        if n_gs:
            changed.append(f"groupStage({n_gs})")
        if n_br:
            changed.append(f"bracket({n_br})")
    except Exception as e:
        print(f"  ! Stage parsing failed (continuing): {e}", file=sys.stderr)

    # Live match results from OpenDota (independent secondary source).
    # Liquipedia stays authoritative for structure; OpenDota fills the live
    # qualifier series and confirms bracket scores so the site updates even
    # between Liquipedia parses.
    try:
        nq, nb = run_opendota(data)
        if nq:
            changed.append(f"qualifierMatches(OpenDota:{nq})")
        if nb:
            changed.append(f"scores(OpenDota:{nb})")
    except Exception as e:
        print(f"  ! OpenDota step failed (continuing): {e}", file=sys.stderr)

    data["meta"]["lastUpdated"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    data["meta"]["dataSource"] = (
        "Auto-updated from Liquipedia (CC-BY-SA) + OpenDota"
        if changed else "Liquipedia reachable; no new structured data yet"
    )

    save(data)
    print("  Updated sections:", ", ".join(changed) if changed else "none (timestamp only)")

    # Feed the prediction league (independent of the git commit).
    try:
        push_league_backend(data)
    except Exception as e:
        print(f"  ! League backend push failed: {e}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
