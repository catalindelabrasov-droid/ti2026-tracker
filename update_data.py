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


def parse_qualifiers(wt):
    """
    Best-effort: detect regional qualifier winners referenced on the page.
    Layout varies; returns None if we can't find structured data so seed
    data is preserved.
    """
    # Look for a "qualified" style section listing region -> team.
    regions = ["Western Europe", "Eastern Europe", "China",
               "Southeast Asia", "North America", "South America"]
    found = {}
    for reg in regions:
        # crude: find region name followed nearby by a TeamOpponent
        pat = re.escape(reg) + r".{0,400}?\{\{TeamOpponent\|([^|}\n]+)"
        m = re.search(pat, wt, re.I | re.S)
        if m:
            found[reg] = clean(m.group(1))
    if not found:
        return None
    out = []
    for reg in regions:
        out.append({
            "region": reg,
            "status": "completed" if reg in found else "pending",
            "winners": [found[reg]] if reg in found else [],
            "dates": "2026-06-15 to 2026-06-28",
        })
    # The region detail views (modal + page) also read optional per-region
    # "teams" (list of names) and "matches" (list of
    # {id, stage, status, teamA:{name,score}, teamB:{name,score}}) plus
    # "slots" (int). Populate these from the regional qualifier subpages when
    # you wire up Match2 parsing; the UI fills in automatically.
    return out


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
            "start": start, "last": 0,
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
    return list(series.values())


def build_series_pair_map(rows, team_names):
    """
    Aggregate game rows into { "team_a_lower|team_b_lower": {a,b,sa,sb} } for
    merging scores into existing bracket/grand-final matches by team names.
    """
    out = {}
    for s in aggregate_series(rows, team_names):
        out[f"{s['a'].lower()}|{s['b'].lower()}"] = s
    if out:
        print(f"  · OpenDota: aggregated {len(out)} main-event series.")
    return out


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")


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
        s = series.get(_match_key(na, nb))
        if not s:
            return
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
    br = data.get("bracket", {}) or {}
    for side in ("upper", "lower"):
        for rnd in (br.get("rounds", {}) or {}).get(side, []) or []:
            for m in (rnd.get("matches") or []):
                apply(m)
    if br.get("grandFinal"):
        apply(br["grandFinal"])
    return updated


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
    br = data.get("bracket") or {}
    for side in ("upper", "lower"):
        for rnd in (br.get("rounds") or {}).get(side) or []:
            for m in rnd.get("matches") or []:
                take(m)
    if br.get("grandFinal"):
        take(br["grandFinal"])
    return rows


def push_match_results(data):
    """
    Upsert decided matches into match_results via PostgREST. Skips cleanly
    when the service-role key isn't in the environment (e.g. local runs).
    """
    if not SUPABASE_SERVICE_ROLE_KEY:
        print("  · Supabase service key not set — skipping match_results push.")
        return 0
    rows = collect_completed_results(data)
    if not rows:
        print("  · No decided matches to push to the league backend.")
        return 0
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/match_results?on_conflict=match_id",
        data=json.dumps(rows).encode("utf-8"),
        headers={
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        method="POST")
    with urllib.request.urlopen(req, timeout=30):
        pass
    print(f"  · Pushed {len(rows)} decided match result(s) to the league backend.")
    return len(rows)


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
            push_match_results(data)
        except Exception as e2:
            print(f"  ! match_results push failed: {e2}", file=sys.stderr)
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

    # Qualifiers
    quals = parse_qualifiers(wt)
    if quals:
        data["qualifiers"] = quals
        changed.append("qualifiers")

    # Teams (with official logos resolved from Liquipedia)
    teams = parse_teams(wt)
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

    # NOTE: Group-stage standings and the playoff bracket live on Liquipedia
    # subpages and use Match2 storage that is non-trivial to parse from
    # wikitext. Hooks are left here intentionally. When you implement them,
    # write into these shapes (the front end already renders them):
    #
    #   data["groupStage"]["standings"] = [
    #       {"team": "...", "wins": 3, "losses": 0, "status": "advanced"}, ...
    #   ]
    #
    #   data["bracket"]["rounds"]["upper"] = [
    #       {"name": "Upper Quarterfinals", "matches": [
    #           {"id": "ubqf1", "bestOf": 3, "status": "completed",
    #            "teamA": {"name": "...", "score": 2},
    #            "teamB": {"name": "...", "score": 0}}, ...
    #       ]}, ...
    #   ]
    #   data["bracket"]["rounds"]["lower"] = [ ...same shape... ]
    #   data["bracket"]["grandFinal"] = {"id": "gf", "bestOf": 5, "status": "...",
    #            "teamA": {...}, "teamB": {...}}
    #
    # The team detail view (click a team in Teams or Group Stage) reads optional
    # per-team "players" and "coach":
    #   "players": [{"ign": "...", "role": "Carry"}, ... up to 5],
    #   "coach": "..."   (use "—" or omit if none)
    # Liquipedia team pages list the active roster + role; populate these from
    # the team page when wiring up parsing. Until then the UI shows a tidy
    # "Roster will fill in from Liquipedia" placeholder.

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

    # Feed the prediction-league leaderboard (independent of the git commit).
    try:
        push_match_results(data)
    except Exception as e:
        print(f"  ! match_results push failed: {e}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
