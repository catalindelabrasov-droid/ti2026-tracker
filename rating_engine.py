#!/usr/bin/env python3
"""
rating_engine.py — our own world ranking for pro Dota teams.

Why this exists: datdota publishes an excellent Glicko-2 ranking, but its
Cloudflare returns 403 to every data-centre IP we can run from (Supabase Edge
Functions and GitHub Actions both verified), so it can only be refreshed by
hand from a home connection. This computes the same kind of rating from match
results we already pull through OpenDota's API — no scraping, no third party
to be blocked by, and it rates every team that plays rather than a curated 35.

The algorithm is Glicko-2 (Glickman, 2001), the standard successor to Elo:
  * a team has a rating, a deviation (how sure we are) and a volatility;
  * beating a strong opponent moves you far more than beating a weak one;
  * a team that stops playing has its deviation grow, so an old rating is
    held less confidently rather than standing forever.

Ratings are updated in weekly periods, which is what Glicko-2 assumes — it is
designed around batches of games, not one-at-a-time updates.
"""

import math

# --- Glicko-2 parameters ----------------------------------------------------
BASE_RATING = 1500.0
BASE_RD = 350.0        # deviation for a team we know nothing about
BASE_VOL = 0.06        # volatility; 0.06 is Glickman's worked example
TAU = 0.5              # constrains volatility change; 0.3–1.2, lower = steadier
SCALE = 173.7178       # Glicko-2 internal scale factor
EPSILON = 0.000001     # convergence tolerance for the volatility solver

# A rating period. Weekly matches how pro schedules cluster (a tournament
# weekend is one batch of results), and matches datdota's cadence.
PERIOD_DAYS = 7
# Below this many series a rating is shown as provisional rather than trusted.
PROVISIONAL_GAMES = 8
# ...and below this it isn't ranked at all. Glicko's rating is a best guess;
# after three games that guess is nearly meaningless, and without this the
# ladder fills with one-weekend teams sitting above Falcons and Spirit.
MIN_GAMES_RANKED = 8
# Leaderboards must order by a CONSERVATIVE estimate, not the raw rating:
# "the rating we're confident they're at least at". Two deviations is the
# usual choice (TrueSkill and Glicko ladders both do this).
CONFIDENCE_K = 2.0
# Deviation is never allowed past this, so a long-absent team decays toward
# "unknown" instead of drifting forever.
MAX_RD = BASE_RD


class Team:
    __slots__ = ("tid", "name", "rating", "rd", "vol", "games", "last_period",
                 "history")

    def __init__(self, tid, name):
        self.tid = tid
        self.name = name
        self.rating = BASE_RATING
        self.rd = BASE_RD
        self.vol = BASE_VOL
        self.games = 0
        self.last_period = None
        self.history = []      # (period_index, rating) for the trend arrow


def _g(phi):
    return 1.0 / math.sqrt(1.0 + 3.0 * phi * phi / (math.pi * math.pi))


def _E(mu, mu_j, phi_j):
    return 1.0 / (1.0 + math.exp(-_g(phi_j) * (mu - mu_j)))


def _new_volatility(phi, sigma, delta, v):
    """Glickman's Illinois-method solver for the new volatility."""
    a = math.log(sigma * sigma)

    def f(x):
        ex = math.exp(x)
        num = ex * (delta * delta - phi * phi - v - ex)
        den = 2.0 * (phi * phi + v + ex) ** 2
        return num / den - (x - a) / (TAU * TAU)

    A = a
    if delta * delta > phi * phi + v:
        B = math.log(delta * delta - phi * phi - v)
    else:
        k = 1
        while f(a - k * TAU) < 0 and k < 100:
            k += 1
        B = a - k * TAU

    fA, fB = f(A), f(B)
    it = 0
    while abs(B - A) > EPSILON and it < 100:
        C = A + (A - B) * fA / (fB - fA)
        fC = f(C)
        if fC * fB <= 0:
            A, fA = B, fB
        else:
            fA /= 2.0
        B, fB = C, fC
        it += 1
    return math.exp(A / 2.0)


def _update_team(team, results, period_index):
    """
    Apply one rating period to a team.
    results: list of (opponent_rating, opponent_rd, score) with score in {0,1}.
    """
    mu = (team.rating - BASE_RATING) / SCALE
    phi = team.rd / SCALE

    if not results:
        # Didn't play: only confidence decays, the rating itself stands.
        phi_star = math.sqrt(phi * phi + team.vol * team.vol)
        team.rd = min(phi_star * SCALE, MAX_RD)
        return

    v_inv = 0.0
    delta_sum = 0.0
    for (r_j, rd_j, s) in results:
        mu_j = (r_j - BASE_RATING) / SCALE
        phi_j = rd_j / SCALE
        g_j = _g(phi_j)
        e_j = _E(mu, mu_j, phi_j)
        v_inv += g_j * g_j * e_j * (1.0 - e_j)
        delta_sum += g_j * (s - e_j)

    if v_inv <= 0:
        return
    v = 1.0 / v_inv
    delta = v * delta_sum

    team.vol = _new_volatility(phi, team.vol, delta, v)
    phi_star = math.sqrt(phi * phi + team.vol * team.vol)
    phi_new = 1.0 / math.sqrt(1.0 / (phi_star * phi_star) + 1.0 / v)
    mu_new = mu + phi_new * phi_new * delta_sum

    team.rating = SCALE * mu_new + BASE_RATING
    team.rd = min(phi_new * SCALE, MAX_RD)
    team.games += len(results)
    team.last_period = period_index


def compute_ratings(series):
    """
    Run Glicko-2 over a list of series and return
    {team_id: {name, rating, rd, games, prev, provisional}}.

    Each series is a dict with team_a_id, team_b_id, team_a, team_b,
    score_a, score_b and started_at (a datetime). Series with no decided
    winner, or missing a team id, are ignored.
    """
    rows = []
    for s in series:
        a, b = s.get("team_a_id"), s.get("team_b_id")
        sa, sb = s.get("score_a") or 0, s.get("score_b") or 0
        when = s.get("started_at")
        if not a or not b or a == b or sa == sb or when is None:
            continue
        rows.append((when, a, b, s.get("team_a"), s.get("team_b"), sa, sb))
    if not rows:
        return {}
    rows.sort(key=lambda r: r[0])

    start = rows[0][0]
    period_of = lambda when: int((when - start).total_seconds() // (PERIOD_DAYS * 86400))
    last_period = period_of(rows[-1][0])

    teams = {}

    def team(tid, name):
        t = teams.get(tid)
        if t is None:
            t = teams[tid] = Team(tid, name)
        if name:
            t.name = name           # keep the most recent name we saw
        return t

    # Bucket series by rating period, then apply each period as one batch —
    # Glicko-2 expects all of a period's games to be scored simultaneously.
    buckets = {}
    for (when, a, b, na, nb, sa, sb) in rows:
        buckets.setdefault(period_of(when), []).append((a, b, na, nb, sa, sb))

    for p in range(last_period + 1):
        batch = buckets.get(p, [])
        pending = {}
        for (a, b, na, nb, sa, sb) in batch:
            ta, tb = team(a, na), team(b, nb)
            # Ratings used for a period are the ones held at its START, so
            # results inside the period don't cascade into each other.
            pending.setdefault(a, []).append((tb.rating, tb.rd, 1.0 if sa > sb else 0.0))
            pending.setdefault(b, []).append((ta.rating, ta.rd, 1.0 if sb > sa else 0.0))
        for tid, t in teams.items():
            _update_team(t, pending.get(tid, []), p)
            t.history.append((p, t.rating))

    out = {}
    for tid, t in teams.items():
        # Rating one period ago, for the 7-day trend arrow.
        prev = None
        for (p, r) in reversed(t.history):
            if p <= last_period - 1:
                prev = r
                break
        out[tid] = {
            "name": t.name,
            "rating": round(t.rating),
            # What we're confident they're at least worth — the ladder sorts
            # on this so a 3-game team can't leapfrog an established one.
            "conservative": round(t.rating - CONFIDENCE_K * t.rd),
            "rd": round(t.rd),
            "games": t.games,
            "prev": round(prev) if prev is not None else None,
            "provisional": t.games < PROVISIONAL_GAMES or t.rd > 150,
        }
    return out


def ranked(ratings, min_games=MIN_GAMES_RANKED):
    """The listable ladder: enough games to mean something, ordered by the
    conservative estimate, strongest first."""
    keep = {k: v for k, v in ratings.items() if v["games"] >= min_games}
    return sorted(keep.items(), key=lambda kv: -kv[1]["conservative"])


def active_ratings(ratings, series, since):
    """Keep only teams that actually played since `since` — a ladder full of
    teams that disbanded months ago is noise."""
    active = set()
    for s in series:
        if s.get("started_at") and s["started_at"] >= since:
            if s.get("team_a_id"):
                active.add(s["team_a_id"])
            if s.get("team_b_id"):
                active.add(s["team_b_id"])
    return {k: v for k, v in ratings.items() if k in active}
