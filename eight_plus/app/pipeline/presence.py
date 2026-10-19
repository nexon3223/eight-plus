#!/usr/bin/env python3
"""
presence.py — free-sleep's presence algorithm, ported. Pure functions.

free-sleep (biometrics/sleep_detection/) does presence in two independent ways
and requires BOTH to agree:

  piezo  detect_presence_piezo: {side}1_avg = the MEAN of each 1 s piezo waveform
         (not peak-to-peak). {side}1_range = rolling-10 s (max-min) of that mean.
         A lying body drifts the DC baseline (weight, breathing, micro-moves)
         even when still, so range >= ~20 000; an empty bed is flat, range ~0.
         range >= threshold, then rolling-10 s >= 70 % -> smoothed.

  cap    detect_presence_cap: combined = Σ (v - mean)/std over out/cen/in vs the
         empty-bed baseline; combined > 5, rolling-10 s >= 90 %.

  final_occupied = piezo + cap  (0 / 1 / 2).  free-sleep's sleep_detector treats
  == 2 as present. We default to >= 1 (either sensor) since one cap pad on this
  Pod may be weak — set REQUIRE_BOTH = True to match free-sleep exactly.

The old live tap threw all this away and used np.ptp(raw samples) > 200 000,
which is dominated by noise and collapses the moment you lie still — which is
why binary_sensor.eight_sleep_pod_*_presence dies every night.
"""
import statistics as st
from collections import deque

# piezo (free-sleep detect_sleep params)
PIEZO_RANGE_THRESHOLD = 20_000
PIEZO_ROLL_SEC = 10
PIEZO_ROLL_FRAC = 0.70
# cap
CAP_OCC_THRESHOLD = 5.0
CAP_ROLL_SEC = 10
CAP_ROLL_FRAC = 0.90
MIN_STD = 5.0
# combine
REQUIRE_BOTH = False
# calibration / block
CAL_MIN_MIN = 5
MERGE_GAP_MIN = 15
BASELINE_PIEZO_RANGE_MAX = 80_000   # free-sleep identify_baseline_period
BASELINE_CAP_CV_MAX = 0.05          # std/mean per pad


# ---------------------------------------------------------------- rolling helpers
def _roll_range(series, win_sec):
    """[(ts, v)] -> [(ts, max-min over a centered +/- win/2 s window)]."""
    out = []
    n = len(series)
    half = win_sec / 2
    j0 = 0
    for i, (ts, _) in enumerate(series):
        while series[j0][0] < ts - half:
            j0 += 1
        j1 = i
        while j1 + 1 < n and series[j1 + 1][0] <= ts + half:
            j1 += 1
        vals = [v for _, v in series[j0:j1 + 1] if v is not None]
        out.append((ts, (max(vals) - min(vals)) if len(vals) > 1 else 0.0))
    return out


def _roll_frac(series, win_sec, frac):
    """[(ts, 0|1)] -> [(ts, 0|1)] where 1 iff >= frac of the last win_sec is 1."""
    out, win, ssum = [], deque(), 0
    for ts, v in series:
        win.append((ts, v)); ssum += v
        while win and ts - win[0][0] > win_sec:
            ssum -= win.popleft()[1]
        need = frac * max(len(win), 1)
        out.append((ts, 1 if ssum >= need else 0))
    return out


def _pct(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * p))]


# ---------------------------------------------------------------- piezo presence
def piezo_occupied(cap_rows):
    """[(ts, 0|1)] from the piezo baseline-drift range (free-sleep style)."""
    pa = [(r["timestamp"], r["piezo_avg"]) for r in cap_rows
          if r.get("piezo_avg") is not None]
    if len(pa) < 20:
        return []
    # drop 2/98-pct outlier records (free-sleep load_piezo_df)
    vals = [v for _, v in pa]
    lo, hi = _pct(vals, 0.02), _pct(vals, 0.98)
    pa = [(t, v) for t, v in pa if lo <= v <= hi] or pa
    rng = _roll_range(pa, PIEZO_ROLL_SEC)
    raw = [(t, 1 if r >= PIEZO_RANGE_THRESHOLD else 0) for t, r in rng]
    return _roll_frac(raw, PIEZO_ROLL_SEC, PIEZO_ROLL_FRAC)


# ---------------------------------------------------------------- cap presence
def _combined(r, base):
    return sum((r[p] - base[p]["mean"]) / base[p]["std"] for p in ("out", "cen", "in"))


def cap_occupied(cap_rows, base, threshold=CAP_OCC_THRESHOLD):
    rows = [r for r in cap_rows if r.get("out") is not None]
    if not rows or not base:
        return []
    raw = [(r["timestamp"], 1 if _combined(r, base) > threshold else 0) for r in rows]
    return _roll_frac(raw, CAP_ROLL_SEC, CAP_ROLL_FRAC)


# ---------------------------------------------------------------- combine
def occupied_series(cap_rows, base):
    """final presence [(ts, 0|1)] = piezo AND/OR cap (see REQUIRE_BOTH)."""
    pz = dict(piezo_occupied(cap_rows))
    cp = dict(cap_occupied(cap_rows, base))
    ts = sorted(set(pz) | set(cp))
    out = []
    for t in ts:
        a, b = pz.get(t, 0), cp.get(t, 0)
        final = (a and b) if REQUIRE_BOTH else (a or b)
        out.append((t, 1 if final else 0))
    return out


def diagnostics(cap_rows, base):
    """what each sensor says on its own, for the dev surfaces."""
    pz = [v for _, v in piezo_occupied(cap_rows)]
    cp = [v for _, v in cap_occupied(cap_rows, base)] if base else []
    return {
        "piezo_occupied_frac": round(sum(pz) / len(pz), 3) if pz else None,
        "cap_occupied_frac": round(sum(cp) / len(cp), 3) if cp else None,
        "n_cap_rows": len(cap_rows),
        "cap_baseline": base,
    }


# ---------------------------------------------------------------- cross-side crosstalk
def overlap_frac(a, b):
    """fraction of interval a=(s,e) covered by interval b=(s,e). 0 if either is missing."""
    if not a or not b:
        return 0.0
    s, e = max(a[0], b[0]), min(a[1], b[1])
    dur = a[1] - a[0]
    return max(0, e - s) / dur if dur else 0.0


# ---------------------------------------------------------------- intervals
def intervals_from_series(series, min_present_sec=60):
    if not series:
        return [], []
    pres, absent = [], []
    cur_v, start = series[0][1], series[0][0]
    for ts, v in series[1:]:
        if v != cur_v:
            (pres if cur_v else absent).append((start, ts))
            start, cur_v = ts, v
    (pres if cur_v else absent).append((start, series[-1][0]))
    pres = [(a, b) for a, b in pres if b - a >= min_present_sec]
    return pres, absent


def main_block(present_intervals, merge_gap_min=MERGE_GAP_MIN):
    if not present_intervals:
        return None
    gap = merge_gap_min * 60
    merged = [list(present_intervals[0])]
    for a, b in present_intervals[1:]:
        if a - merged[-1][1] <= gap:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    best = max(merged, key=lambda m: m[1] - m[0])
    return (int(best[0]), int(best[1]))


def absences_in(not_present_intervals, b0, b1):
    out = []
    for a, b in not_present_intervals:
        a, b = max(a, b0), min(b, b1)
        if b - a >= 60:
            out.append((int(a), int(b)))
    return out


# ---------------------------------------------------------------- calibration
def find_empty_window(cap_rows, min_minutes=CAL_MIN_MIN, assume_empty=False):
    """
    free-sleep identify_baseline_period: a >=5 min window where the piezo range
    stays < BASELINE_PIEZO_RANGE_MAX AND every cap pad's std/mean <= 5 %.
    assume_empty: skip the search, take the most recent min_minutes.
    """
    rows = [r for r in cap_rows if r.get("out") is not None]
    if len(rows) < min_minutes * 30:
        return None
    if assume_empty:
        end = rows[-1]["timestamp"]
        start = end - max(min_minutes, 8) * 60
        seg = [r["timestamp"] for r in rows if r["timestamp"] >= start]
        return (min(seg), end) if len(seg) >= 30 else None

    rng = dict(_roll_range(
        [(r["timestamp"], r.get("piezo_avg")) for r in rows if r.get("piezo_avg") is not None],
        PIEZO_ROLL_SEC))
    win = min_minutes * 60
    best = None
    i = 0
    for i, r0 in enumerate(rows):
        t0 = r0["timestamp"]
        seg = [r for r in rows[i:] if r["timestamp"] < t0 + win]
        if len(seg) < win * 0.5:
            continue
        if any(rng.get(r["timestamp"], 0) >= BASELINE_PIEZO_RANGE_MAX for r in seg):
            continue
        ok = True
        for pad in ("out", "cen", "in"):
            xs = [r[pad] for r in seg]
            m = st.mean(xs)
            if m and (st.pstdev(xs) / abs(m)) > BASELINE_CAP_CV_MAX:
                ok = False
                break
        if ok:
            span = (seg[0]["timestamp"], seg[-1]["timestamp"])
            if best is None or (span[1] - span[0]) > (best[1] - best[0]):
                best = span
    return best


def baseline_from_window(cap_rows, window):
    a, b = window
    seg = [r for r in cap_rows if a <= r["timestamp"] <= b and r.get("out") is not None]
    if len(seg) < 30:
        return None
    out = {}
    for pad in ("out", "cen", "in"):
        xs = [r[pad] for r in seg]
        raw_std = st.pstdev(xs) if len(xs) > 1 else 0
        out[pad] = {"mean": round(st.mean(xs), 2),
                    "std": round(max(raw_std, MIN_STD), 2),
                    "raw_std": round(raw_std, 3)}
    pr = [r["piezo_avg"] for r in seg if r.get("piezo_avg") is not None]
    out["_window"] = [int(a), int(b)]
    out["_n"] = len(seg)
    out["_piezo_avg_mean"] = round(st.mean(pr), 1) if pr else None
    out["_flat"] = all(out[p]["raw_std"] < 0.6 for p in ("out", "cen", "in"))
    return out
