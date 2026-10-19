#!/usr/bin/env python3
"""
Pure sleep-metric computation — no I/O, no side effects.

Inputs are raw rows keyed by (side, epoch):
  vitals    [{timestamp, heart_rate, hrv, breathing_rate}]   ~1/60s, presence-gated
  movement  [{timestamp, total_movement}]                     ~1/60s (may be empty)
  presence  [{taken_at, present, present_for}]                sparse snapshots

Everything is derived — the Pod exposes no sleep stages and this fork's
sleep_records table is not populated. The hypnogram is labelled "estimated".

Ports 1:1 to a TypeScript `server/src/routes/analytics/` module later: same
inputs, same outputs, no dependencies beyond the stdlib.
"""
import datetime as dt
import math
import statistics as st

EPOCH = 60
GAP_MERGE_MIN = 15
MIN_BLOCK_MIN = 45
NIGHT_ANCHOR_HOUR = 12
SLEEP_TARGET_H = 8.0

# hypnogram stage codes (kept small + stable for the card)
WAKE, LIGHT, DEEP, REM = "wake", "light", "deep", "rem"


# ----------------------------------------------------------------- helpers
def _num(v):
    return v if isinstance(v, (int, float)) and v == v and v != 0 else None


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return round(sum(xs) / len(xs), 1) if xs else None


def _roll_mean(xs, w):
    out, s = [], 0.0
    for i, x in enumerate(xs):
        s += x
        if i >= w:
            s -= xs[i - w]
        out.append(s / min(i + 1, w))
    return out


def _roll_std(xs, w):
    out = []
    for i in range(len(xs)):
        seg = xs[max(0, i - w + 1):i + 1]
        out.append(st.pstdev(seg) if len(seg) > 1 else 0.0)
    return out


def _fill(vals):
    """forward/backward fill None gaps so per-epoch features stay continuous."""
    out = list(vals)
    last = None
    for i, v in enumerate(out):
        if v is not None:
            last = v
        elif last is not None:
            out[i] = last
    nxt = None
    for i in range(len(out) - 1, -1, -1):
        if out[i] is not None:
            nxt = out[i]
        elif nxt is not None:
            out[i] = nxt
    return out


# ----------------------------------------------------------------- segmentation
def _epoch_grid(rows_ts, lo, hi):
    return list(range(int(lo // EPOCH * EPOCH), int(hi // EPOCH * EPOCH) + EPOCH, EPOCH))


def _merge_longest(intervals, gap_min, hi):
    """[(a,b)] -> longest span after bridging gaps <= gap_min, within the most
    recent noon->noon window ending at `hi`. -> (start,end) or None."""
    ivs = sorted((int(a), int(b)) for a, b in intervals if b > a)
    if not ivs:
        return None
    gap = gap_min * 60
    merged = [list(ivs[0])]
    for a, b in ivs[1:]:
        if a - merged[-1][1] <= gap:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    anchor = dt.datetime.fromtimestamp(hi).astimezone().replace(
        hour=NIGHT_ANCHOR_HOUR, minute=0, second=0, microsecond=0)
    if anchor.timestamp() > hi:
        anchor -= dt.timedelta(days=1)
    w_lo = anchor.timestamp()
    cand = [m for m in merged if m[1] >= w_lo] or merged
    best = max(cand, key=lambda m: m[1] - m[0])
    if (best[1] - best[0]) < MIN_BLOCK_MIN * 60:
        return None
    return (int(best[0]) // EPOCH * EPOCH, int(best[1]) // EPOCH * EPOCH)   # minute grid, like the vitals keys


def segment_night(vitals, movement, presence, now=None, presence_intervals=None):
    """
    Return (block_start, block_end) epoch for the main overnight sleep block, or
    None.

    If `presence_intervals` ([(start,end),...] from capacitance calibration) is
    given it is authoritative: the block = the longest merged presence span in
    the noon->noon window. Otherwise fall back to the old heuristic (longest run
    of epochs with a vitals/movement row or a present snapshot).
    """
    if presence_intervals:
        hi = max((b for _, b in presence_intervals), default=(now or 0))
        blk = _merge_longest(presence_intervals, GAP_MERGE_MIN, hi)
        if blk:
            return blk
        # fall through to heuristic if presence was too fragmented
    stamps = sorted(
        [int(r["timestamp"]) for r in vitals]
        + [int(r["timestamp"]) for r in movement]
    )
    pres = [(int(p["taken_at"]), int(p["present"])) for p in presence]
    if not stamps and not any(v for _, v in pres):
        return None

    lo = min([s for s in stamps] + [t for t, _ in pres])
    hi = max([s for s in stamps] + [t for t, _ in pres])
    grid = _epoch_grid(stamps, lo, hi)
    occ = {}
    si = 0
    sset = stamps
    import bisect
    for e in grid:
        # any sample within +/-90s
        lft = bisect.bisect_left(sset, e - 90)
        rgt = bisect.bisect_right(sset, e + 90)
        hit = rgt > lft
        if not hit and pres:
            # nearest presence snapshot within 10 min
            for t, v in pres:
                if abs(t - e) <= 600 and v:
                    hit = True
                    break
        occ[e] = hit

    # bridge short gaps
    gap = GAP_MERGE_MIN * 60
    blocks = []
    cur = None
    last_true = None
    for e in grid:
        if occ[e]:
            if cur is None:
                cur = [e, e]
            cur[1] = e
            last_true = e
        else:
            if cur and last_true is not None and (e - last_true) > gap:
                blocks.append(tuple(cur))
                cur = None
    if cur:
        blocks.append(tuple(cur))
    if not blocks:
        return None

    # restrict to the most recent noon->noon window
    anchor = dt.datetime.fromtimestamp(hi).astimezone().replace(
        hour=NIGHT_ANCHOR_HOUR, minute=0, second=0, microsecond=0)
    if anchor.timestamp() > hi:
        anchor -= dt.timedelta(days=1)
    w_lo = anchor.timestamp()
    cand = [b for b in blocks if b[1] >= w_lo] or blocks
    best = max(cand, key=lambda b: b[1] - b[0])
    if (best[1] - best[0]) < MIN_BLOCK_MIN * 60:
        return None
    return best


# ----------------------------------------------------------------- hypnogram
def hypnogram(block, vitals, movement, baseline_hr):
    """
    Per-epoch estimated stage from HR (vs personal baseline), HRV, breathing-rate
    variability and movement. Returns list of {t, stage, hr, hrv, br, move}.
    """
    # the grid MUST sit on whole minutes: vitals are keyed by floor(ts/EPOCH). A block starting at
    # ...:15 never matched a reading -> 0 epochs -> score 24 on every presence night (fixed 2026-09-15).
    b0, b1 = int(block[0]) // EPOCH * EPOCH, int(block[1]) // EPOCH * EPOCH
    grid = list(range(b0, b1 + EPOCH, EPOCH))
    vi = {int(r["timestamp"]) // EPOCH * EPOCH: r for r in vitals}
    mv = {}
    for r in movement:
        k = int(r["timestamp"]) // EPOCH * EPOCH
        mv[k] = mv.get(k, 0) + int(r.get("total_movement") or 0)

    hr_raw = [_num((vi.get(e) or {}).get("heart_rate")) for e in grid]
    hr = _fill(hr_raw)
    hrv = _fill([_num((vi.get(e) or {}).get("hrv")) for e in grid])
    br = _fill([_num((vi.get(e) or {}).get("breathing_rate")) for e in grid])
    move = [mv.get(e, 0) for e in grid]

    have_hr = [i for i, v in enumerate(hr) if v is not None]
    if not have_hr:
        return []
    hr = [v if v is not None else hr[have_hr[0]] for v in hr]
    hr_s = _roll_mean(hr, 5)
    # Self-normalising anchors: read a night against ITS OWN heart-rate spread, not a trailing
    # resting-HR baseline. The old "wake if hr > baseline + 6" marked whole nights awake whenever
    # the sleeper ran a few bpm above their usual (14 Sep: 2h57m "asleep" of 9h24m in bed, score
    # 24) and flipped every score whenever the baseline moved. Fixed 2026-09-15.
    ref = sorted(hr_s)
    pick = lambda q: ref[min(len(ref) - 1, int(len(ref) * q))] if ref else 60.0
    p10, p50, p90 = pick(0.10), pick(0.50), pick(0.90)
    spread = max(4.0, p90 - p10)
    wake_th = p10 + max(7.0, spread * 0.75)
    deep_th = p10 + spread * 0.25
    base = baseline_hr or p10      # kept for the diag block / "vs your usual" only
    br_var = _roll_std([v if v is not None else (br[0] or 14) for v in br], 5)

    have_move = any(move)
    stage = [LIGHT] * len(grid)
    for i, e in enumerate(grid):
        m = move[i]
        motion_wake = (m >= 8) if have_move else False
        if motion_wake or hr_s[i] > wake_th:
            stage[i] = WAKE
        elif hr_s[i] <= deep_th and br_var[i] < 0.8 and (not have_move or m == 0):
            stage[i] = DEEP

    # ---- REM (2026-09-15 rework) ----
    # The old rule gated on a FIXED breathing-variability threshold (1.3) and required HRV to be
    # BELOW the night's own mean — a made-up direction with no literature behind it. Together they
    # starved REM to ~8-10% of sleep on nights whose absolute breathing variability just happened
    # to sit under 1.3, regardless of shape. Real sleep architecture puts REM at ~20-25% of total
    # sleep and concentrated in the back half of each ~90-min cycle, growing longer through the
    # night — so instead of an absolute cutoff, rank the still, non-deep, non-wake epochs by their
    # OWN night's breathing-rate variability (the one real REM-adjacent signal this sensor set
    # has), weight that ranking toward the late-cycle position a real REM period would occupy, and
    # take the top ~22% of those epochs as sleep's target REM share (capped by how many still
    # epochs actually exist — a night with genuinely flat breathing all night won't get REM forced
    # onto it).
    cand = [i for i in range(len(grid)) if stage[i] == LIGHT and (not have_move or move[i] <= 1)]
    asleep_n = sum(1 for st in stage if st != WAKE)
    if cand and asleep_n:
        onset = next((i for i, st in enumerate(stage) if st != WAKE), 0)
        cycle = max(1, round(90 * 60 / EPOCH))   # ~90-min ultradian cycle, in epochs

        def late_cycle_weight(i):
            phase = ((i - onset) % cycle) / cycle
            # flat outside the back 45% of a cycle; a soft bump rising into the wake-ward edge,
            # where real REM periods sit and lengthen as the night goes on
            return 1.0 if phase < 0.55 else 1.0 + 0.9 * math.sin((phase - 0.55) / 0.45 * math.pi / 2)
        scored = sorted(cand, key=lambda i: br_var[i] * late_cycle_weight(i), reverse=True)
        target = min(len(cand), round(asleep_n * 0.22))
        for i in scored[:target]:
            stage[i] = REM

    out = []
    for i, e in enumerate(grid):
        out.append({
            "t": e, "stage": stage[i],
            "hr": round(hr[i], 1) if hr[i] is not None else None,
            "hr_ok": hr_raw[i] is not None,   # a real reading this minute (hr itself is gap-filled)
            "hrv": round(hrv[i], 1) if hrv[i] else None,
            "br": round(br[i], 1) if br[i] is not None else None,
            "move": move[i],
        })

    # smooth: drop 1-epoch islands
    for i in range(1, len(out) - 1):
        if out[i]["stage"] != out[i - 1]["stage"] == out[i + 1]["stage"]:
            out[i]["stage"] = out[i - 1]["stage"]
    # a wake run under 5 min with nothing but a heart-rate blip behind it is a stir, not an
    # awakening — otherwise a restless sleeper collects a dozen "wake-ups" a night
    i = 0
    while i < len(out):
        if out[i]["stage"] != WAKE:
            i += 1
            continue
        j = i
        while j < len(out) and out[j]["stage"] == WAKE:
            j += 1
        if j - i < 5 and i > 0 and j < len(out) and not any(o["move"] >= 8 for o in out[i:j]):
            for o in out[i:j]:
                o["stage"] = LIGHT
        i = j
    # likewise a REM run under 3 min is scattered scoring noise, not a real REM period
    i = 0
    while i < len(out):
        if out[i]["stage"] != REM:
            i += 1
            continue
        j = i
        while j < len(out) and out[j]["stage"] == REM:
            j += 1
        if j - i < 3:
            for o in out[i:j]:
                o["stage"] = LIGHT
        i = j
    return out


# ----------------------------------------------------------------- metrics
def _resting_hr(hr_series):
    """min + mean of the lowest sustained 30-min window of in-bed HR."""
    xs = [(t, v) for t, v in hr_series if v]
    if len(xs) < 3:
        return None, None
    win = 30 * 60
    best = None
    for i in range(len(xs)):
        seg = [v for t, v in xs if xs[i][0] <= t < xs[i][0] + win]
        if len(seg) >= 3:
            mean = sum(seg) / len(seg)
            if best is None or mean < best[0]:
                best = (mean, min(seg))
    if best is None:
        vals = [v for _, v in xs]
        return round(min(vals), 1), round(sum(vals) / len(vals), 1)
    return round(best[1], 1), round(best[0], 1)


def _still_stretch(hyp):
    longest = cur = 0
    for h in hyp:
        moving = h["move"] >= 2 or h["stage"] == WAKE
        cur = 0 if moving else cur + EPOCH
        longest = max(longest, cur)
    return round(longest / 60, 1)


def nightly(side, block, rows, baseline, absences=None, presence_source="heuristic"):
    """
    block: (start, end) epoch. rows: {vitals, movement, presence}.
    baseline: {"resting_hr": float|None, "hrv_mean": float|None} from trailing nights.
    absences: [(a,b),...] real out-of-bed intervals within the block, from
              capacitance presence — those epochs are forced to WAKE.
    Returns (summary_dict, series_dict).
    """
    b0, b1 = int(block[0]) // EPOCH * EPOCH, int(block[1]) // EPOCH * EPOCH
    block = (b0, b1)
    vit = [r for r in rows["vitals"] if b0 - 90 <= r["timestamp"] <= b1 + 90]
    mov = [r for r in rows["movement"] if b0 - 90 <= r["timestamp"] <= b1 + 90]
    in_bed_s = b1 - b0
    absences = absences or []

    base_hr = (baseline or {}).get("resting_hr")
    hyp = hypnogram(block, vit, mov, base_hr)
    oob_s = 0
    for h in hyp:
        if any(a <= h["t"] < b for a, b in absences):
            h["stage"] = WAKE
            h["out_of_bed"] = True
            oob_s += EPOCH

    # sleep vs wake from the hypnogram
    asleep_epochs = [h for h in hyp if h["stage"] != WAKE]
    onset_i = next((i for i, h in enumerate(hyp)
                    if h["stage"] != WAKE
                    and sum(1 for g in hyp[i:i + 10] if g["stage"] != WAKE) >= min(8, len(hyp) - i)), None)
    final_i = next((len(hyp) - 1 - i for i, h in enumerate(reversed(hyp))
                    if h["stage"] != WAKE), None)

    if onset_i is None:
        latency_min = None
        sleep_period = []
        tst_s = 0
    else:
        latency_min = round((hyp[onset_i]["t"] - b0) / 60, 1)
        sleep_period = hyp[onset_i:final_i + 1]
        tst_s = sum(EPOCH for h in sleep_period if h["stage"] != WAKE)

    waso_s = sum(EPOCH for h in sleep_period if h["stage"] == WAKE)
    # awakenings: contiguous wake runs >= 3 min within the sleep period, OR any
    # run that includes an out-of-bed epoch (getting up always counts).
    awk, run, run_oob, run_t0, wake_runs = 0, 0, False, None, []
    for h in sleep_period:
        if h["stage"] == WAKE:
            if run == 0:
                run_t0 = h["t"]
            run += EPOCH
            run_oob = run_oob or h.get("out_of_bed", False)
        else:
            if run >= 180 or run_oob:
                awk += 1
                wake_runs.append((run_t0, run, run_oob))
            run, run_oob = 0, False
    if run >= 180 or run_oob:
        awk += 1
        wake_runs.append((run_t0, run, run_oob))

    final_wake_ep = min(b1, hyp[final_i]["t"] + EPOCH) if final_i is not None else b1
    tst_s = min(tst_s, in_bed_s)                 # grid is inclusive of b1 -> clamp
    waso_s = min(waso_s, max(0, in_bed_s - tst_s))
    eff = round(min(100.0, 100 * tst_s / in_bed_s), 1) if in_bed_s else None

    hr_series = [(h["t"], h["hr"]) for h in hyp if h.get("hr_ok")]
    rhr_min, rhr_mean = _resting_hr(hr_series)

    hrv_vals = [h["hrv"] for h in hyp if h["hrv"]]
    br_vals = [h["br"] for h in hyp if h["br"]]
    move_total = sum(h["move"] for h in hyp)
    move_events = sum(1 for h in hyp if h["move"] >= 2)
    hours = in_bed_s / 3600

    stage_min = {s: round(sum(EPOCH for h in hyp if h["stage"] == s) / 60, 1)
                 for s in (WAKE, LIGHT, DEEP, REM)}

    # ---- confidence
    # "low" is reserved for nights whose numbers can't be trusted (thin heart-rate coverage, a very
    # short block). Standing limits of this Pod - no movement channel, no HRV lock, vitals-only
    # presence - are notes, not low confidence, or every single night would read "rough estimate".
    hard, soft = [], []
    cov = len([h for h in hyp if h.get("hr_ok")]) / max(1, len(hyp))
    if cov < 0.4:
        hard.append(f"sparse vitals ({cov*100:.0f}% epoch coverage)")
    if hours < 2:
        hard.append("short in-bed block")
    if not hrv_vals:
        soft.append("no valid HRV (needs sustained still sleep)")
    if not mov:
        soft.append("no movement data (restlessness estimated from HR/breathing)")
    if presence_source == "heuristic":
        soft.append("presence from vitals coverage (piezo/cap presence unavailable)")
    reasons = hard + soft
    confidence = "low" if hard else ("ok" if (cov < 0.75 or soft) else "good")

    hrv_mean = _mean(hrv_vals)
    hrv_base = (baseline or {}).get("hrv_mean")
    hrv_delta = (round(hrv_mean - hrv_base, 1)
                 if hrv_mean is not None and hrv_base else None)

    # ---- moments + run-length stages (what the card's Report draws)
    raw_hr = [(h["t"], h["hr"]) for h in hyp if h.get("hr_ok")]
    lo_t = lo_v = None
    if onset_i is not None and raw_hr:
        t_on, t_off = hyp[onset_i]["t"], hyp[final_i]["t"]
        inside = [(t, v) for t, v in raw_hr if t_on <= t <= t_off]
        for t, _v in inside:
            win = [v for t2, v in inside if abs(t2 - t) <= 300]
            if len(win) >= 3:
                m = sum(win) / len(win)
                if lo_v is None or m < lo_v:
                    lo_t, lo_v = t, m
    events = [{"t": int(b0), "kind": "in_bed"}]
    if onset_i is not None:
        events.append({"t": hyp[onset_i]["t"], "kind": "asleep", "min": latency_min})
    for t0, dur, oob in wake_runs:
        events.append({"t": t0, "kind": "out_of_bed" if oob else "awake", "min": round(dur / 60)})
    if lo_t is not None:
        events.append({"t": lo_t, "kind": "lowest_hr", "bpm": round(lo_v)})
    events.append({"t": int(b1), "kind": "up", "asleep_min": round(tst_s / 60)})
    events.sort(key=lambda e: e["t"])
    stage_runs = []
    for h in hyp:
        if stage_runs and stage_runs[-1][2] == h["stage"] and stage_runs[-1][1] == h["t"]:
            stage_runs[-1][1] = h["t"] + EPOCH
        else:
            stage_runs.append([h["t"], h["t"] + EPOCH, h["stage"]])

    summary = {
        "date": dt.datetime.fromtimestamp(b0).astimezone().date().isoformat(),
        "side": side,
        "computed_at": int(dt.datetime.now().timestamp()),
        "in_bed_start": int(b0),
        "in_bed_end": int(b1),
        "final_wake_at": int(final_wake_ep),
        "time_in_bed_min": round(in_bed_s / 60, 1),
        "time_asleep_min": round(tst_s / 60, 1),
        "sleep_latency_min": latency_min,
        "waso_min": round(waso_s / 60, 1),
        "out_of_bed_min": round(oob_s / 60, 1),
        "awakenings": awk,
        "efficiency_pct": eff,
        "presence_source": presence_source,
        "stages_min": stage_min,
        "resting_hr": rhr_mean,
        "resting_hr_min": rhr_min,
        "hrv_mean": hrv_mean,
        "hrv_max": round(max(hrv_vals), 1) if hrv_vals else None,
        "hrv_vs_baseline": hrv_delta,
        "respiratory_rate_mean": _mean(br_vals),
        "respiratory_rate_min": round(min(br_vals), 1) if br_vals else None,
        "respiratory_rate_max": round(max(br_vals), 1) if br_vals else None,
        "restlessness_per_hr": round(move_events / hours, 1) if hours else None,
        "movement_total": move_total,
        "longest_still_min": _still_stretch(hyp),
        "confidence": confidence,
        "confidence_notes": reasons,
        "events": events,
        # ---- dev / deep-dive diagnostics ----
        "diag": {
            "epoch_sec": EPOCH,
            "epochs_total": len(hyp),
            "epochs_with_hr": len([h for h in hyp if h["hr"]]),
            "epochs_with_hrv": len(hrv_vals),
            "epochs_with_br": len(br_vals),
            "vitals_rows_in_window": len(vit),
            "movement_rows_in_window": len(mov),
            "vitals_coverage_pct": round(cov * 100, 1),
            "hr_epoch_coverage_pct": round(cov * 100, 1),
            "onset_epoch_index": onset_i,
            "final_sleep_epoch_index": final_i,
            "baseline": baseline or {},
            "baseline_hr_used": base_hr,
            "hypnogram_rules": {
                "deep": "hr >= baseline+2bpm (5-epoch mean) AND br_var(5) < 0.8 AND no motion",
                "rem": "br_var(5) >= 1.3 AND hr < baseline+3 AND still AND hrv not elevated",
                "wake": "movement >= 8/epoch OR hr > baseline+6 OR presence gap",
                "light": "everything else",
            },
            "params": {
                "GAP_MERGE_MIN": GAP_MERGE_MIN, "MIN_BLOCK_MIN": MIN_BLOCK_MIN,
                "NIGHT_ANCHOR_HOUR": NIGHT_ANCHOR_HOUR, "SLEEP_TARGET_H": SLEEP_TARGET_H,
            },
        },
    }
    _score, summary["score_breakdown"] = sleep_score(summary, baseline, want_breakdown=True)
    summary["sleep_score"] = _score

    series = {
        "epoch": EPOCH,
        "start": int(b0),
        "hypnogram": [[h["t"], h["stage"]] for h in hyp],
        "stage_runs": stage_runs,
        "heart_rate": [[h["t"], h["hr"]] for h in hyp if h.get("hr_ok")],
        "hrv": [[h["t"], h["hrv"]] for h in hyp if h["hrv"]],
        "breathing_rate": [[h["t"], h["br"]] for h in hyp if h["br"]],
        "movement": [[h["t"], h["move"]] for h in hyp],
    }
    return summary, series


# ----------------------------------------------------------------- score
def sleep_score(s, baseline, want_breakdown=False):
    """0-100 from efficiency + duration-vs-target + restfulness + HRV-vs-baseline.
    want_breakdown=True -> (score, breakdown_dict) with the per-component maths."""
    parts = []

    eff = s.get("efficiency_pct")
    if eff is not None:
        parts.append(("efficiency", 0.35, max(0, min(1, (eff - 60) / 35))))

    tst_h = (s.get("time_asleep_min") or 0) / 60
    dur = max(0.0, 1 - abs(tst_h - SLEEP_TARGET_H) / SLEEP_TARGET_H)
    parts.append(("duration", 0.30, dur))

    # restfulness: fewer awakenings + WASO + restlessness
    awk = s.get("awakenings") or 0
    waso = s.get("waso_min") or 0
    restless = s.get("restlessness_per_hr")
    rest = 1.0
    rest -= min(0.5, awk * 0.1)
    rest -= min(0.3, waso / 90 * 0.3)
    if restless is not None:
        rest -= min(0.3, restless / 20 * 0.3)
    parts.append(("restfulness", 0.20, max(0, rest)))

    hrv_mean = s.get("hrv_mean")
    hrv_base = (baseline or {}).get("hrv_mean")
    if hrv_mean is not None and hrv_base:
        parts.append(("hrv", 0.15, max(0, min(1, 0.5 + (hrv_mean - hrv_base) / hrv_base))))
    elif hrv_mean is not None:
        parts.append(("hrv", 0.15, 0.6))

    wsum = sum(w for _, w, _ in parts)
    score = sum(w * v for _, w, v in parts) / wsum if wsum else 0
    out = round(score * 100)
    capped = False   # no cap since 2026-09-15: publish the true score; the card shows confidence on its own
    breakdown = {
        "components": [
            {"name": n, "weight": w, "value": round(v, 3),
             "points": round(w * v / wsum * 100, 1) if wsum else 0}
            for n, w, v in parts
        ],
        "weight_sum": round(wsum, 2),
        "raw": round(score * 100, 1),
        "low_confidence_cap": capped,
        "final": out,
    }
    return (out, breakdown) if want_breakdown else out


# ----------------------------------------------------------------- trend
def trend(summaries, key):
    """[{date, value}] oldest->newest for a summary key, skipping missing."""
    out = []
    for s in sorted(summaries, key=lambda x: x.get("date", "")):
        v = s.get(key)
        if isinstance(v, (int, float)):
            out.append({"date": s["date"], "value": v})
    return out


def normal_range(values, min_half_width):
    """Personal normal range from prior nights: median +/- max(1.5 * MAD * 1.4826, min_half_width).
    lo/hi are None until there are 5 nights to go on."""
    vals = [v for v in values if isinstance(v, (int, float))]
    if len(vals) < 5:
        return {"lo": None, "hi": None, "median": round(st.median(vals), 1) if vals else None, "n": len(vals)}
    med = st.median(vals)
    mad = st.median([abs(v - med) for v in vals]) * 1.4826
    half = max(1.5 * mad, min_half_width)
    return {"lo": round(med - half, 1), "hi": round(med + half, 1), "median": round(med, 1), "n": len(vals)}


def baseline_from(summaries):
    """trailing-window baseline: median resting HR + median HRV mean."""
    rhr = [s["resting_hr"] for s in summaries if isinstance(s.get("resting_hr"), (int, float))]
    hrv = [s["hrv_mean"] for s in summaries if isinstance(s.get("hrv_mean"), (int, float))]
    return {
        "resting_hr": round(st.median(rhr), 1) if rhr else None,
        "hrv_mean": round(st.median(hrv), 1) if hrv else None,
        "nights": len(summaries),
    }
