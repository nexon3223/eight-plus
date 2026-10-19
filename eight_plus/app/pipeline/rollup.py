#!/usr/bin/env python3
"""
rollup — nightly job (ported verbatim from ~/pod-sleep-pipeline/bin/rollup.py; only main() differs). Segments the most recent night from the local store,
computes every metric (analyze.py), writes one nightly_summary row + the raw
overnight series. Side-effect free except for the two store writes.

Run ~2h after typical wake (launchd calendar), and on demand:
  rollup.py                # last night, both sides
  rollup.py --date 2026-09-08 --side right
  rollup.py --backfill 14  # re-roll the last 14 nights
"""
import argparse
import datetime as dt
import sys
import time

import config as C
import store
import analyze
import presence as pres
import calibrate


def log(*a):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), "rollup", *a, flush=True)


def _other_side(side):
    return C.SIDES[1] if side == C.SIDES[0] else C.SIDES[0]


def _window_for(date):
    """
    `date` is the WAKE date (the morning you got up). The night = the sleep that
    ends that morning, so the search window is noon(date-1) .. noon(date). This
    keeps a post-midnight bedtime (e.g. 00:23) in the same night as an 22:00 one.
    """
    d0 = dt.datetime.fromisoformat(date).replace(
        hour=C.NIGHT_ANCHOR_HOUR, minute=0, second=0).astimezone()
    return int((d0 - dt.timedelta(days=1)).timestamp()), int(d0.timestamp())


def roll_one(con, side, date):
    lo, hi = _window_for(date)
    rows = store.rows_between(con, side, lo - 3 * 3600, hi)

    # free-sleep-style presence: piezo baseline-drift range (works without any
    # calibration) OR'd with capacitance z-score (needs an empty-bed baseline).
    cap = store.cap_between(con, side, lo - 3 * 3600, hi)
    base, cal_at = calibrate.load_baseline(con, side)
    p_intervals = p_absences = None
    p_source = "heuristic"
    p_diag = None

    heur_block = analyze.segment_night(rows["vitals"], rows["movement"], rows["presence"])

    if cap:
        p_diag = pres.diagnostics(cap, base)
        occ = pres.occupied_series(cap, base)
        frac = sum(v for _, v in occ) / max(1, len(occ))
        p_intervals, not_present = pres.intervals_from_series(occ)
        blk = pres.main_block(p_intervals)
        # accept only if the sensor responded and the block roughly matches the
        # vitals-derived one (guards a dead/stuck sensor)
        plausible = (blk and 0.02 < frac < 0.98
                     and (not heur_block
                          or (blk[1] - blk[0]) >= 0.55 * (heur_block[1] - heur_block[0])))
        if plausible:
            p_absences = pres.absences_in(not_present, *blk)
            pf, cf = p_diag["piezo_occupied_frac"], p_diag["cap_occupied_frac"]
            p_source = "piezo+cap" if (base and cf and cf > 0.02) else "piezo"
        elif blk or frac:
            log(f"{date} {side}: presence rejected (occ {frac*100:.0f}%, "
                f"piezo {p_diag['piezo_occupied_frac']}, cap {p_diag['cap_occupied_frac']}) "
                f"— using vitals heuristic")

    block = analyze.segment_night(rows["vitals"], rows["movement"], rows["presence"],
                                  presence_intervals=p_intervals if p_source != "heuristic" else None)
    # presence can read "in bed" for hours either side of the real night (lying on the bed in the
    # evening, phantom vitals). Trust it only within PRESENCE_EDGE_SLACK_MIN of the vitals-derived
    # night. 2026-09-14 right: presence 17:16 -> 11:16 (an 18 h "night", resting HR 41) -> trimmed.
    if block and heur_block and p_source != "heuristic":
        slack = C.PRESENCE_EDGE_SLACK_MIN * 60
        trimmed = (max(block[0], heur_block[0] - slack), min(block[1], heur_block[1] + slack))
        if trimmed != tuple(block):
            def fmt(b):
                return f"{dt.datetime.fromtimestamp(b[0]):%d %H:%M}-{dt.datetime.fromtimestamp(b[1]):%d %H:%M}"
            log(f"{date} {side}: presence block {fmt(block)} trimmed to {fmt(trimmed)} "
                f"(vitals night +/-{C.PRESENCE_EDGE_SLACK_MIN}m)")
            block = trimmed if trimmed[1] - trimmed[0] >= C.MIN_BLOCK_MIN * 60 else heur_block
    # ---- crosstalk guard ----
    # A side whose own cap sensor never corroborates presence has no independent proof anyone
    # was there: piezo vibration — and the vitals derived from it — can leak across the shared
    # frame from the other side's real occupant. Verified 2026-09-15: every "partner" (left)
    # night on record was a near-total subset of the right side's cap-corroborated block, and
    # left's own cap never once agreed (cap_occupied_frac 0.0 every night). If this side's block
    # is almost entirely covered by the OTHER side's independently cap-backed occupancy, and this
    # side's own cap gave no corroboration, treat it as crosstalk rather than a real night.
    if block and p_source != "piezo+cap":
        other = _other_side(side)
        other_cap = store.cap_between(con, other, lo - 3 * 3600, hi)
        other_base, _ = calibrate.load_baseline(con, other)
        if other_cap and other_base:
            other_diag = pres.diagnostics(other_cap, other_base)
            other_cf = other_diag["cap_occupied_frac"]
            if other_cf and other_cf > 0.02:
                other_ivs, _ = pres.intervals_from_series(pres.occupied_series(other_cap, other_base))
                other_blk = pres.main_block(other_ivs)
                ov = pres.overlap_frac(block, other_blk) if other_blk else 0.0
                if ov >= 0.8:
                    log(f"{date} {side}: block {ov*100:.0f}% covered by {other}'s cap-corroborated "
                        f"night, with no corroboration of its own — treating as crosstalk from "
                        f"{other}, not a real night")
                    if store.delete_nightly(con, date, side):
                        con.commit()
                        log(f"{date} {side}: removed the stale summary stored for this night")
                    return None
    if not block:
        log(f"{date} {side}: no sleep block found "
            f"({len(rows['vitals'])} vitals / {len(rows['movement'])} movement / "
            f"{len(cap)} cap rows · presence={p_source})")
        if store.delete_nightly(con, date, side):   # an older, wrong summary for this night
            con.commit()
            log(f"{date} {side}: removed the stale summary stored for this night")
        return None
    prior = store.recent_summaries(con, side, date, C.BASELINE_NIGHTS)
    baseline = analyze.baseline_from(prior)
    abs_in = pres.absences_in(p_absences or [], *block) if p_absences else None
    summary, series = analyze.nightly(side, block, rows, baseline,
                                      absences=abs_in, presence_source=p_source)
    summary["wake_date"] = date
    if p_diag:
        summary["presence_diag"] = p_diag
    # store row keyed by the WAKE date (`date`); summary["date"] keeps the
    # in-bed-start calendar date as a fact.
    store.save_nightly(con, date, side, summary, series)
    con.commit()
    log(f"{date} {side}: score {summary['sleep_score']} · "
        f"{summary['time_asleep_min']:.0f}m asleep / {summary['time_in_bed_min']:.0f}m in bed · "
        f"eff {summary['efficiency_pct']}% · presence {p_source}"
        + (f" (piezo {p_diag['piezo_occupied_frac']}/cap {p_diag['cap_occupied_frac']})" if p_diag else "")
        + f" · conf {summary['confidence']}"
        + (f" · {summary['confidence_notes']}" if summary['confidence_notes'] else ""))
    return summary



def run(dates=None, sides=None, backfill=0):
    """Roll the given WAKE dates (default: today) for the given sides. Returns summaries."""
    con = store.connect(C.STORE_DB)
    sides = list(sides or C.SIDES)
    for msg in calibrate.ensure_fresh(con, int(time.time()) - 24 * 3600, int(time.time())):
        log("calibrate", msg)
    if backfill:
        today = dt.date.today()
        dates = [(today - dt.timedelta(days=i)).isoformat() for i in range(backfill)]
    dates = dates or [dt.date.today().isoformat()]
    out = {}
    for d in dates:
        for s in sides:
            out[(d, s)] = roll_one(con, s, d)
    store.set_meta(con, "last_rollup", int(time.time()))
    con.commit()
    con.close()
    return out
