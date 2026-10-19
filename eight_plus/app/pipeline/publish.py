"""
publish — nightly summaries -> Home Assistant, one set of sensors per SLEEPER.

    sensor.<prefix>_sleep_score        0-100, every metric + the Sleep tab's data as attributes
    sensor.<prefix>_sleep_duration     h asleep
    sensor.<prefix>_sleep_efficiency   %
    sensor.<prefix>_resting_heart_rate bpm
    sensor.<prefix>_hrv_avg            ms
    sensor.<prefix>_respiratory_rate   br/min
    sensor.<prefix>_awakenings         count

Over MQTT discovery (retained) when a broker is available; otherwise straight into HA's state
machine over REST (re-sent on HA start and every hour, since those states don't survive a
restart). Attribute payloads are the standalone pipeline's, byte for byte — the card's Sleep
tab reads them unchanged — plus a small `coach` block (sleep debt) the Coach automations use.
"""
import datetime as dt
import json
import time

import config as C
import store
import analyze
from mqtt_min import publish_once

METRICS = [
    ("sleep_score", "Sleep score", None, "mdi:sleep", None, "sleep_score", lambda v: v),
    ("sleep_duration", "Sleep duration", "h", "mdi:bed-clock", "duration",
     "time_asleep_min", lambda v: round(v / 60, 2) if v is not None else None),
    ("sleep_efficiency", "Sleep efficiency", "%", "mdi:percent", None, "efficiency_pct", lambda v: v),
    ("resting_heart_rate", "Resting heart rate", "bpm", "mdi:heart-pulse", None, "resting_hr", lambda v: v),
    ("hrv_avg", "HRV (avg)", "ms", "mdi:heart-flash", None, "hrv_mean", lambda v: v),
    ("respiratory_rate", "Respiratory rate", "br/min", "mdi:lungs", None, "respiratory_rate_mean", lambda v: v),
    ("awakenings", "Awakenings", None, "mdi:sleep-off", None, "awakenings", lambda v: v),
]
MEASUREMENT = {"sleep_score", "sleep_efficiency", "resting_heart_rate", "hrv_avg", "respiratory_rate",
               "sleep_duration"}
STAGE_CODE = {"wake": "w", "light": "l", "deep": "d", "rem": "r"}


def _topics(slug):
    return f"eightplus/sleep/{slug}/state", f"eightplus/sleep/{slug}/attributes"


def discovery_for(side):
    sl = C.SLEEPERS[side]
    st, at = _topics(sl["slug"])
    out = []
    for key, label, unit, icon, dclass, _f, _t in METRICS:
        cfg = {
            "name": label, "unique_id": f"eight_plus_{sl['slug']}_{key}",
            "object_id": f"{sl['p']}_{key}", "state_topic": st,
            "value_template": "{{ value_json.%s }}" % key,
            "availability_topic": C.MQTT["avail_topic"],
            "device": {**C.DEVICE, "identifiers": [f"eight_plus_sleep_{sl['slug']}"],
                       "name": f"{sl['name']}'s sleep"},
        }
        if unit:
            cfg["unit_of_measurement"] = unit
        if icon:
            cfg["icon"] = icon
        if dclass:
            cfg["device_class"] = dclass
        if key in MEASUREMENT:
            cfg["state_class"] = "measurement"
        if key == "sleep_score":
            cfg["json_attributes_topic"] = at
        out.append((f"{C.DISCOVERY_PREFIX}/sensor/{C.MQTT_NODE}/{sl['slug']}_{key}/config", json.dumps(cfg), True))
    return out


def _compact(date, s, ser):
    b0 = s.get("in_bed_start") or 0
    runs = [[round((a - b0) / 60), round((b - a) / 60), STAGE_CODE.get(stg, "l")]
            for a, b, stg in (ser.get("stage_runs") or [])]
    buckets = {}
    for t, v in ser.get("heart_rate") or []:
        buckets.setdefault(int((t - b0) // 600), []).append(v)
    hr10 = [[k * 10 + 5, round(sum(v) / len(v), 1)] for k, v in sorted(buckets.items())]
    sb = s.get("score_breakdown") or {}
    wsum = sb.get("weight_sum") or 1
    bd = [[c["name"], c["points"], round(c["weight"] / wsum * 100)] for c in sb.get("components") or []]
    return {
        "wake_date": date, "score": s.get("sleep_score"), "confidence": s.get("confidence"),
        "notes": s.get("confidence_notes") or [], "in_bed_start": b0, "in_bed_end": s.get("in_bed_end"),
        "in_bed_min": s.get("time_in_bed_min"), "asleep_min": s.get("time_asleep_min"),
        "latency_min": s.get("sleep_latency_min"), "waso_min": s.get("waso_min"),
        "awakenings": s.get("awakenings"), "efficiency": s.get("efficiency_pct"),
        "resting_hr": s.get("resting_hr"), "hrv_mean": s.get("hrv_mean"),
        "br_mean": s.get("respiratory_rate_mean"), "stages_min": s.get("stages_min"),
        "breakdown": bd, "runs": runs, "hr10": hr10, "events": s.get("events") or [],
    }


def _hist_row(date, s):
    return {"wake_date": date, "score": s.get("sleep_score"), "confidence": s.get("confidence"),
            "in_bed_start": s.get("in_bed_start"), "in_bed_end": s.get("in_bed_end"),
            "asleep_min": s.get("time_asleep_min"), "resting_hr": s.get("resting_hr"),
            "hrv_mean": s.get("hrv_mean"), "br_mean": s.get("respiratory_rate_mean")}


def _coach(hist30, need_h):
    """Sleep debt over the last 7 nights vs this sleeper's need — what the Coach's 6 pm
    automation pulls tonight's target earlier by."""
    last7 = [s for _d, s in hist30[-7:]]
    debt = sum(max(0.0, need_h * 60 - (s.get("time_asleep_min") or 0)) for s in last7 if s.get("time_asleep_min"))
    return {"debt_min": int(round(debt)), "nights": len(last7), "need_h": need_h}


def payloads(con, side, date, need_h=8.0):
    """(state dict, attributes dict) for one side, or None if it has never had a night."""
    summary = store.get_nightly(con, side, date)
    prior = store.recent_nights(con, side, date, C.HISTORY_NIGHTS)
    if not summary and not prior:
        return None
    real = summary is not None
    summary = summary or {}
    series = store.get_series(con, side, date) or {}
    state = {key: tf(summary.get(field)) for key, _l, _u, _i, _d, field, tf in METRICS}
    hist = [s for _d, s, _ser in reversed(prior[:C.BASELINE_NIGHTS])] + ([summary] if real else [])
    hist30 = [(d, s) for d, s, _ser in reversed(prior)]
    attrs = {
        **{k: summary.get(k) for k in (
            "date", "in_bed_start", "in_bed_end", "final_wake_at", "time_in_bed_min", "time_asleep_min",
            "sleep_latency_min", "waso_min", "awakenings", "efficiency_pct", "stages_min", "resting_hr",
            "resting_hr_min", "hrv_mean", "hrv_max", "hrv_vs_baseline", "respiratory_rate_mean",
            "respiratory_rate_min", "respiratory_rate_max", "restlessness_per_hr", "longest_still_min",
            "sleep_score", "confidence", "confidence_notes", "computed_at", "movement_total",
            "score_breakdown", "diag", "out_of_bed_min", "presence_source")},
        "epoch": series.get("epoch", C.EPOCH),
        "hypnogram": series.get("hypnogram", []),
        "heart_rate": series.get("heart_rate", []),
        "hrv": series.get("hrv", []),
        "breathing_rate": series.get("breathing_rate", []),
        "trend": {k: analyze.trend(hist, k) for k in
                  ("sleep_score", "efficiency_pct", "time_asleep_min", "resting_hr", "hrv_mean")},
        "wake_date": date,
        "events": summary.get("events", []),
        "stage_runs": series.get("stage_runs", []),
        "nights": [_compact(d, s, ser) for d, s, ser in reversed(prior[:C.BASELINE_NIGHTS - 1])]
                  + ([_compact(date, summary, series)] if real else []),
        "history": [_hist_row(d, s) for d, s in hist30] + ([_hist_row(date, summary)] if real else []),
        "ranges": {
            "resting_hr": analyze.normal_range([s.get("resting_hr") for _d, s in hist30], 3.0),
            "hrv_mean": analyze.normal_range([s.get("hrv_mean") for _d, s in hist30], 8.0),
            "respiratory_rate_mean": analyze.normal_range([s.get("respiratory_rate_mean") for _d, s in hist30], 0.6),
        },
        "coach": _coach(hist30 + ([(date, summary)] if real else []), need_h),
        "source": "eight_plus",
    }
    return state, attrs


def publish(ha=None, date=None, needs=None, log=print):
    """Publish every sleeper's latest night. MQTT if configured, else REST via `ha`."""
    date = date or dt.date.today().isoformat()
    con = store.connect(C.STORE_DB)
    msgs, rest = [], []
    try:
        for side, sl in C.SLEEPERS.items():
            p = payloads(con, side, date, (needs or {}).get(side, 8.0))
            if C.MQTT.get("host"):
                msgs += discovery_for(side)
                if p:
                    st, at = _topics(sl["slug"])
                    msgs += [(at, json.dumps(p[1]), True), (st, json.dumps(p[0]), True)]
            elif p:
                rest.append((sl, p))
    finally:
        con.close()
    if msgs:
        publish_once(C.MQTT, msgs)
        log(f"publish: {len(msgs)} retained MQTT messages")
    for sl, (state, attrs) in rest:
        for key, label, unit, icon, _dc, _f, _t in METRICS:
            a = {"friendly_name": f"{sl['name']} {label}", "icon": icon}
            if unit:
                a["unit_of_measurement"] = unit
            if key in MEASUREMENT:
                a["state_class"] = "measurement"
            if key == "sleep_score":
                a.update(attrs)
            v = state.get(key)
            ha.rest("POST", f"/states/sensor.{sl['p']}_{key}",
                    {"state": "unknown" if v is None else v, "attributes": a})
        log(f"publish: {sl['name']} via REST")
    return {"mqtt": len(msgs), "rest": len(rest), "date": date, "at": time.time()}
