"""
Collectors — fill the store's `vitals` + `presence_snap` tables, keyed (side, timestamp),
exactly the shape the standalone pipeline's analyze/rollup expect.

HACollector (default, every backend)
    Watches each sleeper's heart-rate / HRV / breathing / presence entities through Home
    Assistant and writes one row per minute. On first run (and after downtime) it backfills
    from HA's recorder, so last night's report can appear minutes after install.

SSHCollector (optional, rooted gateway or free-sleep Pods)
    Pulls the Pod's own free-sleep.db over SSH — denser vitals, movement, and (gateway only)
    the capacitance presence signal. Use one source or the other, never both: they'd write
    the same nights at different timestamps and double the density.
"""
import json
import os
import shlex
import sqlite3
import subprocess
import tempfile
import threading
import time
import datetime as dt

import config as C
import store

VITALS = ("heart_rate", "hrv", "breath_rate")
COL = {"heart_rate": "heart_rate", "hrv": "hrv", "breath_rate": "breathing_rate"}
# Raw bed-presence sensors blip ON for 15–30 s every few minutes while the bed is EMPTY and
# drop for a minute or two through a real night. "In bed" = on for >= 40 % of the trailing
# 15 minutes — the debounce proven on real nights (one clean block, ~10 min lag on getting up).
# Vitals are only recorded while in bed: anything else is crosstalk or noise.
DEBOUNCE_MIN = 15
DEBOUNCE_FRAC = 0.4


class _Debounce:
    def __init__(self):
        self.win = []          # last DEBOUNCE_MIN raw samples (1/min)
        self.state = False
        self.since = 0

    def push(self, raw, t):
        self.win.append(1 if raw else 0)
        if len(self.win) > DEBOUNCE_MIN:
            self.win.pop(0)
        on = sum(self.win) / len(self.win) >= DEBOUNCE_FRAC
        if on != self.state:
            self.state, self.since = on, t
        return on


def _num(v):
    try:
        f = float(v)
        return None if f != f or f <= 0 else f
    except (TypeError, ValueError):
        return None


class HACollector:
    def __init__(self, ha, sides, log=print):
        """sides: {"left": {"heart_rate": eid, "hrv": eid, "breath_rate": eid, "presence": eid}, ...}"""
        self.ha, self.sides, self.log = ha, sides, log
        self.cache = {}          # eid -> {"s": state, "lu": ts, "lc": ts}
        self.lock = threading.Lock()
        self.stats = {"rows": 0, "last_row": None, "backfilled": 0}
        self._stop = threading.Event()
        self._deb = {side: _Debounce() for side in sides}

    def entity_ids(self):
        return sorted({e for d in self.sides.values() for e in d.values() if e})

    # ---- live
    def start(self):
        ids = self.entity_ids()
        if not ids:
            return
        self.ha.subscribe("collector", {"type": "subscribe_entities", "entity_ids": ids}, self._on_event)
        threading.Thread(target=self._loop, daemon=True, name="collector").start()

    def stop(self):
        self._stop.set()

    def _on_event(self, ev):
        now = time.time()
        with self.lock:
            for eid, d in (ev.get("a") or {}).items():
                self.cache[eid] = {"s": d.get("s"), "lu": d.get("lu") or d.get("lc") or now,
                                   "lc": d.get("lc") or now}
            for eid, diff in (ev.get("c") or {}).items():
                plus = diff.get("+") or {}
                cur = self.cache.setdefault(eid, {"s": None, "lu": now, "lc": now})
                if "s" in plus:
                    if plus["s"] != cur["s"]:
                        cur["lc"] = plus.get("lc") or plus.get("lu") or now
                    cur["s"] = plus["s"]
                cur["lu"] = plus.get("lu") or plus.get("lc") or now
            for eid in ev.get("r") or []:
                self.cache.pop(eid, None)

    def _loop(self):
        while not self._stop.is_set():
            time.sleep(60 - (time.time() % 60) + 1)
            try:
                self.sample(int(time.time() // 60 * 60))
            except Exception as e:  # noqa: BLE001
                self.log("collector sample failed:", repr(e))

    def sample(self, t):
        with self.lock:
            snap = {k: dict(v) for k, v in self.cache.items()}
        vit, pres = [], []
        for side, ents in self.sides.items():
            p = snap.get(ents.get("presence") or "")
            if not p or p["s"] not in ("on", "off"):
                continue
            d = self._deb[side]
            present = d.push(p["s"] == "on", t)
            pres.append((side, present, int(t - d.since) if present else 0))
            if not present:
                continue
            row = {"side": side, "timestamp": t}
            for k in VITALS:
                e = snap.get(ents.get(k) or "")
                v = _num(e["s"]) if e else None
                if v is not None:          # steady values don't bump last_updated — no age test
                    row[COL[k]] = v
            if any(COL[k] in row for k in VITALS):
                vit.append(row)
        if not vit and not pres:
            return 0
        con = store.connect(C.STORE_DB)
        try:
            if vit:
                store.upsert_vitals(con, vit)
            for side, present, pfor in pres:
                store.snap_presence(con, {side: {"present": present, "present_for": pfor}}, taken_at=t)
            store.set_meta(con, "last_seen_ts", t)
            con.commit()
        finally:
            con.close()
        self.stats["rows"] += len(vit)
        self.stats["last_row"] = t
        return len(vit)

    # ---- recorder backfill
    def backfill(self, days=7):
        """Rebuild per-minute rows from HA history for the gap since the last live sample."""
        ids = self.entity_ids()
        if not ids:
            return 0
        con = store.connect(C.STORE_DB)
        last = int(store.get_meta(con, "last_seen_ts", 0) or 0)
        con.close()
        end = int(time.time() // 60 * 60)
        start = max(last + 60, end - days * 86400)
        if end - start < 300:
            return 0
        iso = lambda ts: dt.datetime.fromtimestamp(ts, dt.timezone.utc).isoformat()  # noqa: E731
        hist = self.ha.call({"type": "history/history_during_period", "start_time": iso(start - 3600),
                             "end_time": iso(end), "entity_ids": ids, "minimal_response": True,
                             "no_attributes": True, "significant_changes_only": False}, timeout=180) or {}
        series = {}
        for eid, rows in hist.items():
            pts = []
            for r in rows:
                ts = r.get("lu") or r.get("lc")
                if ts is not None:
                    pts.append((float(ts), r.get("s")))
            series[eid] = sorted(pts)
        idx = {eid: 0 for eid in series}
        cur = {eid: None for eid in series}          # (ts, state, since)
        deb = {side: _Debounce() for side in self.sides}
        vit, pres = [], []
        for t in range(start - start % 60 - DEBOUNCE_MIN * 60, end, 60):
            for eid, pts in series.items():
                i = idx[eid]
                while i < len(pts) and pts[i][0] <= t:
                    prev = cur[eid]
                    since = prev[2] if prev and prev[1] == pts[i][1] else pts[i][0]
                    cur[eid] = (pts[i][0], pts[i][1], since)
                    i += 1
                idx[eid] = i
            for side, ents in self.sides.items():
                p = cur.get(ents.get("presence") or "")
                if not p or p[1] not in ("on", "off"):
                    continue
                present = deb[side].push(p[1] == "on", t)
                if t < start:
                    continue                           # only warming the debounce window
                pres.append((side, present, int(t - deb[side].since) if present else 0, t))
                if not present:
                    continue
                row = {"side": side, "timestamp": t}
                for k in VITALS:
                    c = cur.get(ents.get(k) or "")
                    v = _num(c[1]) if c else None
                    # HA only records a state CHANGE: a steady vital keeps its last value, so in
                    # history the staleness bound is the sensor's own "unavailable", not its age
                    if v is not None:
                        row[COL[k]] = v
                if any(COL[k] in row for k in VITALS):
                    vit.append(row)
        con = store.connect(C.STORE_DB)
        try:
            if vit:
                store.upsert_vitals(con, vit)
            # presence: one snapshot per 5 min is plenty for segmentation and keeps the table small
            for side, present, pfor, t in pres:
                if t % 300 == 0:
                    store.snap_presence(con, {side: {"present": present, "present_for": pfor}}, taken_at=t)
            store.set_meta(con, "last_seen_ts", end)
            con.commit()
        finally:
            con.close()
        self.stats["backfilled"] += len(vit)
        self.log(f"collector: backfilled {len(vit)} vitals rows from HA history "
                 f"({(end - start) / 3600:.1f} h)")
        return len(vit)


class SSHCollector:
    """The standalone pipeline's collector, with the SSH command built from add-on options."""

    def __init__(self, host, port=8822, user="root", key="/data/ssh/id_ed25519", sudo=True, raw_cap=False,
                 log=print):
        self.log = log
        self.raw_cap = raw_cap
        C.POD_SSH = (f"ssh -i {shlex.quote(key)} -p {int(port)} -o StrictHostKeyChecking=accept-new "
                     f"-o UserKnownHostsFile={shlex.quote(os.path.join(os.path.dirname(key), 'known_hosts'))} -o ConnectTimeout=10 "
                     f"-o BatchMode=yes {shlex.quote(user)}@{shlex.quote(host)}")
        C.POD_DB_NEEDS_SUDO = bool(sudo)
        self.stats = {"runs": 0, "last_ok": None, "last_error": None}

    def _ssh(self, cmd, timeout=60):
        return subprocess.run(shlex.split(C.POD_SSH) + [cmd], capture_output=True, timeout=timeout)

    def test(self):
        r = self._ssh("echo ok && ls -la " + shlex.quote(C.POD_DB), timeout=20)
        return r.returncode == 0, (r.stdout + r.stderr).decode(errors="replace")[-600:]

    def _cat(self, path):
        pfx = "sudo -n " if C.POD_DB_NEEDS_SUDO else ""
        r = self._ssh(f"{pfx}cat {shlex.quote(path)}")
        if r.returncode != 0:
            raise RuntimeError(f"ssh cat {path}: {r.stderr.decode(errors='replace')[:200]}")
        return r.stdout

    def run(self):
        con = store.connect(C.STORE_DB)
        try:
            last = int(store.get_meta(con, "last_seen_ts", 0) or 0)
            since = last or int(time.time() - 36 * 3600)
            with tempfile.TemporaryDirectory() as td:
                base = os.path.join(td, "free-sleep.db")
                open(base, "wb").write(self._cat(C.POD_DB))
                for ext in ("-wal", "-shm"):
                    try:
                        open(base + ext, "wb").write(self._cat(C.POD_DB + ext))
                    except RuntimeError:
                        pass
                src = sqlite3.connect(f"file:{base}?mode=ro", uri=True)
                src.row_factory = sqlite3.Row
                vit = [dict(r) for r in src.execute(
                    "SELECT side,timestamp,heart_rate,hrv,breathing_rate FROM vitals WHERE timestamp>? "
                    "ORDER BY timestamp", (since,))]
                try:
                    mov = [dict(r) for r in src.execute(
                        "SELECT side,timestamp,total_movement FROM movement WHERE timestamp>? "
                        "ORDER BY timestamp", (since,))]
                except sqlite3.OperationalError:
                    mov = []
                src.close()
            if vit:
                store.upsert_vitals(con, vit)
            if mov:
                store.upsert_movement(con, mov)
            try:
                store.snap_presence(con, json.loads(self._cat(C.POD_PRESENCE).decode()))
            except Exception as e:  # noqa: BLE001
                self.log("presence snap skipped:", e)
            if self.raw_cap:
                try:
                    import raw
                    raw.pull_and_store(con, store)
                except Exception as e:  # noqa: BLE001
                    self.log("cap/RAW pull skipped:", e)
            mx = max([int(r["timestamp"]) for r in vit + mov] + [last])
            store.set_meta(con, "last_seen_ts", mx)
            con.commit()
            self.stats.update(runs=self.stats["runs"] + 1, last_ok=time.time(), last_error=None)
            self.log(f"ssh collector: +{len(vit)} vitals, +{len(mov)} movement")
        except Exception as e:  # noqa: BLE001
            self.stats["last_error"] = str(e)
            raise
        finally:
            con.close()
