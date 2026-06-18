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
# Set the TI 2026 league id once it's known (find it via OpenDota /leagues or
# the match page). Until it's set, the OpenDota step is skipped cleanly.
OPENDOTA_API = "https://api.opendota.com/api"
OPENDOTA_LEAGUE_ID = os.environ.get("OPENDOTA_LEAGUE_ID", "").strip()  # e.g. "17126"
OPENDOTA_KEY = os.environ.get("OPENDOTA_API_KEY", "").strip()          # optional, higher limits

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


def fetch_opendota_results():
    """
    Pull finished pro matches for the TI 2026 league from OpenDota and return a
    map keyed by a normalized "TeamA|TeamB" plus a list of raw series rows.

    OpenDota's /proMatches returns individual GAMES (one row per game in a
    series), each with radiant/dire names + which side won. We aggregate games
    into series scores per opposing-team pair.

    Returns: { "team_a_lower|team_b_lower": {"a": name, "b": name,
                                             "sa": int, "sb": int} }
    or {} if the league id isn't set / the call fails.
    """
    if not OPENDOTA_LEAGUE_ID:
        print("  · OpenDota league id not set — skipping results merge.")
        return {}
    try:
        # /proMatches is a recent feed; filter to our league client-side.
        # (For a single tournament this is enough; for history use
        #  /leagues/{id}/matches once available.)
        rows = opendota_get(f"/leagues/{OPENDOTA_LEAGUE_ID}/matches")
    except Exception as e:
        print(f"  ! OpenDota unreachable: {e}", file=sys.stderr)
        return {}
    if not isinstance(rows, list) or not rows:
        print("  · OpenDota returned no matches for this league yet.")
        return {}

    series = {}
    for g in rows:
        rad = (g.get("radiant_name") or "").strip()
        dire = (g.get("dire_name") or "").strip()
        if not rad or not dire:
            continue
        # stable key independent of side/order
        a, b = sorted([rad, dire], key=str.lower)
        key = f"{a.lower()}|{b.lower()}"
        s = series.setdefault(key, {"a": a, "b": b, "sa": 0, "sb": 0})
        radiant_win = g.get("radiant_win")
        if radiant_win is None:
            continue
        winner = rad if radiant_win else dire
        if winner.lower() == s["a"].lower():
            s["sa"] += 1
        else:
            s["sb"] += 1
    print(f"  · OpenDota: aggregated {len(series)} series from {len(rows)} games.")
    return series


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
            series = fetch_opendota_results()
            n = merge_opendota_scores(data, series)
            if n:
                print(f"  · OpenDota updated {n} match score(s) despite Liquipedia outage.")
        except Exception as e2:
            print(f"  ! OpenDota merge failed: {e2}", file=sys.stderr)
        data["meta"]["lastUpdated"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        save(data)
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
    # Liquipedia stays authoritative for structure; OpenDota fills/confirms the
    # actual scores so the site updates even between Liquipedia parses.
    try:
        series = fetch_opendota_results()
        n = merge_opendota_scores(data, series)
        if n:
            changed.append(f"scores(OpenDota:{n})")
    except Exception as e:
        print(f"  ! OpenDota step failed (continuing): {e}", file=sys.stderr)

    data["meta"]["lastUpdated"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    data["meta"]["dataSource"] = (
        "Auto-updated from Liquipedia (CC-BY-SA) + OpenDota"
        if changed else "Liquipedia reachable; no new structured data yet"
    )

    save(data)
    print("  Updated sections:", ", ".join(changed) if changed else "none (timestamp only)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
