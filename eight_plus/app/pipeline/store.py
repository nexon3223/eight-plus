#!/usr/bin/env python3
"""
Durable local store for the sleep pipeline (SQLite on this machine).

Tables:
  vitals(side, timestamp, heart_rate, hrv, breathing_rate)   PK (side, timestamp)
  movement(side, timestamp, total_movement)                  PK (side, timestamp)
  presence_snap(taken_at, side, present, present_for)         PK (taken_at, side)
  nightly_summary(date, side, computed_at, confidence, summary_json)  PK (date, side)
  night_series(date, side, series_json)                       PK (date, side)
  meta(key, value)

`vitals` / `movement` keep the free-sleep column names on purpose, so the dev
harness (analytics/analytics_dev.py DB_FILE=…) reads this store unchanged.
"""
import json
import sqlite3
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS vitals(
  side TEXT NOT NULL, timestamp INTEGER NOT NULL,
  heart_rate REAL, hrv REAL, breathing_rate REAL,
  PRIMARY KEY (side, timestamp));
CREATE TABLE IF NOT EXISTS movement(
  side TEXT NOT NULL, timestamp INTEGER NOT NULL,
  total_movement INTEGER NOT NULL,
  PRIMARY KEY (side, timestamp));
CREATE TABLE IF NOT EXISTS presence_snap(
  taken_at INTEGER NOT NULL, side TEXT NOT NULL,
  present INTEGER NOT NULL, present_for INTEGER,
  PRIMARY KEY (taken_at, side));
CREATE TABLE IF NOT EXISTS nightly_summary(
  date TEXT NOT NULL, side TEXT NOT NULL,
  computed_at INTEGER NOT NULL, confidence TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  PRIMARY KEY (date, side));
CREATE TABLE IF NOT EXISTS night_series(
  date TEXT NOT NULL, side TEXT NOT NULL, series_json TEXT NOT NULL,
  PRIMARY KEY (date, side));
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
-- capacitance presence signal, decoded from /persistent/*.RAW by the collector.
-- out/cen/in = the three cap pads per side; piezo_range = np.ptp of that second's
-- piezo waveform (bed-quiet proxy). ~1-2 rows/sec while a RAW file is live.
CREATE TABLE IF NOT EXISTS cap(
  side TEXT NOT NULL, timestamp INTEGER NOT NULL,
  out REAL, cen REAL, "in" REAL, piezo_range REAL, piezo_avg REAL,
  PRIMARY KEY (side, timestamp));
CREATE INDEX IF NOT EXISTS vitals_ts ON vitals(timestamp);
CREATE INDEX IF NOT EXISTS movement_ts ON movement(timestamp);
CREATE INDEX IF NOT EXISTS cap_ts ON cap(timestamp);
"""


def connect(path):
    con = sqlite3.connect(path, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL;")
    con.executescript(SCHEMA)
    # lightweight migrations
    cols = {r[1] for r in con.execute("PRAGMA table_info(cap)")}
    if "piezo_avg" not in cols:
        con.execute("ALTER TABLE cap ADD COLUMN piezo_avg REAL")
    return con


# ------------------------------------------------------------ ingest
def upsert_vitals(con, rows):
    con.executemany(
        "INSERT INTO vitals(side,timestamp,heart_rate,hrv,breathing_rate) "
        "VALUES(?,?,?,?,?) ON CONFLICT(side,timestamp) DO UPDATE SET "
        "heart_rate=excluded.heart_rate, hrv=excluded.hrv, "
        "breathing_rate=excluded.breathing_rate",
        [(r["side"], int(r["timestamp"]), _f(r.get("heart_rate")),
          _f(r.get("hrv")), _f(r.get("breathing_rate"))) for r in rows],
    )
    return con.total_changes


def upsert_movement(con, rows):
    con.executemany(
        "INSERT INTO movement(side,timestamp,total_movement) VALUES(?,?,?) "
        "ON CONFLICT(side,timestamp) DO UPDATE SET "
        "total_movement=excluded.total_movement",
        [(r["side"], int(r["timestamp"]), int(r.get("total_movement") or 0))
         for r in rows],
    )
    return con.total_changes


def upsert_cap(con, rows):
    con.executemany(
        'INSERT INTO cap(side,timestamp,out,cen,"in",piezo_range,piezo_avg) '
        'VALUES(?,?,?,?,?,?,?) '
        'ON CONFLICT(side,timestamp) DO UPDATE SET out=excluded.out, cen=excluded.cen, '
        '"in"=excluded."in", piezo_range=COALESCE(excluded.piezo_range,cap.piezo_range), '
        'piezo_avg=COALESCE(excluded.piezo_avg,cap.piezo_avg)',
        [(r["side"], int(r["timestamp"]), _f(r.get("out")), _f(r.get("cen")),
          _f(r.get("in")), _f(r.get("piezo_range")), _f(r.get("piezo_avg"))) for r in rows],
    )
    return con.total_changes


def cap_between(con, side, lo, hi):
    return [dict(r) for r in con.execute(
        'SELECT timestamp,out,cen,"in",piezo_range,piezo_avg FROM cap '
        "WHERE side=? AND timestamp BETWEEN ? AND ? ORDER BY timestamp", (side, lo, hi))]


def snap_presence(con, presence, taken_at=None):
    taken_at = int(taken_at or time.time())
    for side, v in (presence or {}).items():
        if side not in ("left", "right") or not isinstance(v, dict):
            continue
        con.execute(
            "INSERT OR REPLACE INTO presence_snap(taken_at,side,present,present_for) "
            "VALUES(?,?,?,?)",
            (taken_at, side, 1 if v.get("present") else 0,
             int(v.get("present_for") or 0)),
        )


def get_meta(con, key, default=None):
    r = con.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return r[0] if r else default


def set_meta(con, key, value):
    con.execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)",
                (key, str(value)))


# ------------------------------------------------------------ read
def rows_between(con, side, lo, hi):
    v = [dict(r) for r in con.execute(
        "SELECT side,timestamp,heart_rate,hrv,breathing_rate FROM vitals "
        "WHERE side=? AND timestamp BETWEEN ? AND ? ORDER BY timestamp",
        (side, lo, hi))]
    m = [dict(r) for r in con.execute(
        "SELECT side,timestamp,total_movement FROM movement "
        "WHERE side=? AND timestamp BETWEEN ? AND ? ORDER BY timestamp",
        (side, lo, hi))]
    p = [dict(r) for r in con.execute(
        "SELECT taken_at,side,present,present_for FROM presence_snap "
        "WHERE side=? AND taken_at BETWEEN ? AND ? ORDER BY taken_at",
        (side, lo, hi))]
    return {"vitals": v, "movement": m, "presence": p}


def save_nightly(con, date, side, summary, series):
    con.execute(
        "INSERT OR REPLACE INTO nightly_summary"
        "(date,side,computed_at,confidence,summary_json) VALUES(?,?,?,?,?)",
        (date, side, int(time.time()), summary.get("confidence", "unknown"),
         json.dumps(summary)))
    con.execute(
        "INSERT OR REPLACE INTO night_series(date,side,series_json) VALUES(?,?,?)",
        (date, side, json.dumps(series)))


def recent_summaries(con, side, before_date, n):
    return [json.loads(r[0]) for r in con.execute(
        "SELECT summary_json FROM nightly_summary WHERE side=? AND date<? "
        "ORDER BY date DESC LIMIT ?", (side, before_date, n))]


def delete_nightly(con, date, side):
    """Drop a stored night (a re-roll that no longer finds a block must not leave the old row behind)."""
    n = con.execute("DELETE FROM nightly_summary WHERE date=? AND side=?", (date, side)).rowcount
    con.execute("DELETE FROM night_series WHERE date=? AND side=?", (date, side))
    return n


def recent_nights(con, side, before_date, n):
    """[(wake_date, summary, series)] newest first, strictly before `before_date`."""
    return [(r[0], json.loads(r[1]), json.loads(r[2]) if r[2] else {}) for r in con.execute(
        "SELECT s.date, s.summary_json, n.series_json FROM nightly_summary s "
        "LEFT JOIN night_series n ON n.date = s.date AND n.side = s.side "
        "WHERE s.side=? AND s.date<? ORDER BY s.date DESC LIMIT ?", (side, before_date, n))]


def get_nightly(con, side, date):
    r = con.execute(
        "SELECT summary_json FROM nightly_summary WHERE side=? AND date=?",
        (side, date)).fetchone()
    return json.loads(r[0]) if r else None


def get_series(con, side, date):
    r = con.execute(
        "SELECT series_json FROM night_series WHERE side=? AND date=?",
        (side, date)).fetchone()
    return json.loads(r[0]) if r else None


def _f(v):
    try:
        f = float(v)
        return None if f != f else f
    except (TypeError, ValueError):
        return None
