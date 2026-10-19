#!/usr/bin/env python3
"""
calibrate.py — per-side empty-bed capacitance baseline (free-sleep style).

  calibrate.py                      # auto: newest empty stretch in the last 18h
  calibrate.py --window "2026-09-10 12:00" "2026-09-10 12:20"
  calibrate.py --side left
  calibrate.py --show               # print stored baselines + age

Baselines live in the store `meta` table as cap_baseline_{side} (JSON) +
cap_baseline_{side}_at (epoch). rollup.py auto-runs this when a baseline is
missing or older than STALE_DAYS and an empty stretch is available.
"""
import argparse
import datetime as dt
import json
import sys
import time

import config as C
import store
import presence

STALE_DAYS = 14
LOOKBACK_H = 18


def _parse(s):
    return int(dt.datetime.fromisoformat(s).timestamp())


def calibrate_side(con, side, lo, hi, force_window=None, assume_empty=False):
    cap = store.cap_between(con, side, lo, hi)
    if not cap:
        return None, "no cap rows in window (collector needs RAW history)"
    win = force_window or presence.find_empty_window(cap, assume_empty=assume_empty)
    if not win:
        return None, "no flat (empty) stretch >=5 min found — pass --assume-empty"
    base = presence.baseline_from_window(cap, win)
    if not base:
        return None, "empty window too sparse"
    store.set_meta(con, f"cap_baseline_{side}", json.dumps(base))
    store.set_meta(con, f"cap_baseline_{side}_at", int(time.time()))
    con.commit()
    a, b = base["_window"]
    flat = "  ⚠ SENSOR FLAT/PEGGED — cap presence unreliable this side" if base.get("_flat") else ""
    return base, (f"window {dt.datetime.fromtimestamp(a):%H:%M}–{dt.datetime.fromtimestamp(b):%H:%M} "
                  f"({base['_n']} samples)  out/cen/in "
                  f"{base['out']['mean']}/{base['cen']['mean']}/{base['in']['mean']} "
                  f"raw_std {base['out']['raw_std']}/{base['cen']['raw_std']}/{base['in']['raw_std']}"
                  + flat)


def load_baseline(con, side):
    j = store.get_meta(con, f"cap_baseline_{side}")
    at = store.get_meta(con, f"cap_baseline_{side}_at")
    return (json.loads(j) if j else None), (int(at) if at else None)


def is_stale(at):
    return at is None or (time.time() - at) > STALE_DAYS * 86400


def ensure_fresh(con, lo, hi):
    """Called by rollup: (re)calibrate any side whose baseline is missing/stale."""
    done = []
    for side in C.SIDES:
        _, at = load_baseline(con, side)
        if is_stale(at):
            base, msg = calibrate_side(con, side, lo, hi)
            done.append(f"{side}: {'ok — ' + msg if base else 'skipped — ' + msg}")
    return done


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--side", choices=C.SIDES)
    ap.add_argument("--window", nargs=2, metavar=("START", "END"))
    ap.add_argument("--assume-empty", action="store_true",
                    help="the bed IS empty right now — baseline the recent window as-is")
    ap.add_argument("--show", action="store_true")
    a = ap.parse_args()
    con = store.connect(C.STORE_DB)

    if a.show:
        for side in C.SIDES:
            base, at = load_baseline(con, side)
            age = f"{(time.time()-at)/86400:.1f}d ago" if at else "never"
            print(f"\n{side}: calibrated {age}"
                  + ("  STALE" if is_stale(at) else ""))
            if base:
                for pad in ("out", "cen", "in"):
                    print(f"  {pad:4} mean {base[pad]['mean']:>8}  std {base[pad]['std']}")
                w = base.get("_window")
                if w:
                    print(f"  from {dt.datetime.fromtimestamp(w[0])} → "
                          f"{dt.datetime.fromtimestamp(w[1])}  ({base.get('_n')} samples)")
        return 0

    hi = int(time.time())
    lo = hi - LOOKBACK_H * 3600
    win = None
    if a.window:
        lo, hi = _parse(a.window[0]), _parse(a.window[1])
        win = (lo, hi)
    sides = [a.side] if a.side else list(C.SIDES)
    ok = False
    for side in sides:
        base, msg = calibrate_side(con, side, lo, hi, force_window=win,
                                   assume_empty=a.assume_empty)
        print(f"{side}: {'✓ ' + msg if base else '✗ ' + msg}")
        ok = ok or bool(base)
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
