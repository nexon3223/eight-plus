#!/usr/bin/env python3
"""
Offline checks for the Eight+ generator — no Home Assistant needed.

    python3 tests/test_generator.py            # all backends × solo/couple × feature mixes
    python3 tests/test_generator.py --dump DIR # also write the rendered files for eyeballing

Checks: every rendered file parses as YAML; every automation id is unique; every Jinja
template compiles (HA's extra filters/tests stubbed); the Autopilot macro renders to JSON
with sane numbers against fake states; card configs reference only entities the install
creates or detection found.
"""
import datetime as dt
import json
import os
import re
import sys

import yaml
import jinja2

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "eight_plus", "app"))
import generator as G  # noqa: E402
import detect as D  # noqa: E402

FIX = os.path.join(ROOT, "tests", "fixtures")

HA_FILTERS = ["float", "int", "from_json", "to_json", "is_number", "as_timestamp", "as_local",
              "timestamp_custom", "round", "abs", "min", "max", "lower", "title", "string", "list",
              "count", "select", "reject", "selectattr", "map", "join", "default", "string"]
HA_TESTS = ["is_number", "is_state", "in", "number", "none", "defined"]


def ha_env():
    env = jinja2.Environment(extensions=["jinja2.ext.loopcontrols"])
    for f in HA_FILTERS:
        env.filters.setdefault(f, lambda *a, **k: a[0] if a else None)
    for t in HA_TESTS:
        env.tests.setdefault(t, lambda *a, **k: True)
    return env


def jinja_strings(node, out):
    if isinstance(node, dict):
        for v in node.values():
            jinja_strings(v, out)
    elif isinstance(node, list):
        for v in node:
            jinja_strings(v, out)
    elif isinstance(node, str) and ("{{" in node or "{%" in node):
        out.append(node)
    return out


def check_plan(plan, label):
    env = ha_env()
    env.loader = jinja2.DictLoader({"eight_plus.jinja": plan["files"]["custom_templates/eight_plus.jinja"]})
    ids = []
    for path, text in plan["files"].items():
        if not path.endswith(".yaml"):
            continue
        try:
            doc = yaml.safe_load(text)
        except yaml.YAMLError as e:
            raise AssertionError(f"[{label}] {path} is not valid YAML: {e}") from e
        assert isinstance(doc, dict), f"[{label}] {path} is empty"
        for a in doc.get("automation") or []:
            assert a.get("id") and a.get("alias"), f"[{label}] automation without id/alias in {path}"
            assert a.get("triggers") and a.get("actions"), f"[{label}] {a['id']} has no triggers/actions"
            ids.append(a["id"])
        for s in jinja_strings(doc, []):
            try:
                env.parse(s)
            except jinja2.TemplateSyntaxError as e:
                raise AssertionError(f"[{label}] {path}: bad Jinja ({e}) in:\n{s[:300]}") from e
        leftovers = re.findall(r"\$\{[A-Z_]+\}", text)
        assert not leftovers, f"[{label}] {path} has unrendered {leftovers}"
    dup = {i for i in ids if ids.count(i) > 1}
    assert not dup, f"[{label}] duplicate automation ids {dup}"
    env.parse(plan["files"]["custom_templates/eight_plus.jinja"])
    # every entity the card points at must exist: created here, or found by detection
    known = set(plan["entities"])
    for slug, card in plan["cards"].items():
        for k, v in card.items():
            if isinstance(v, str) and re.fullmatch(r"(input_\w+|counter|sensor|binary_sensor|script)\.eight_(sleep|plus)_\w+", v):
                if v.startswith(("sensor.eight_sleep_pod", "binary_sensor.eight_sleep_pod", "script.eight_sleep_pod")):
                    continue  # detected gateway entities / bed package script
                if k.endswith("_prefix") or k in ("sleep_score_entity", "partner_sleep_score_entity"):
                    continue  # published by the pipeline, not the package
                assert v in known, f"[{label}] card {slug}.{k} -> {v} is never created"
    return len(ids)


# ───────────────────────────────────────── the Autopilot macro, evaluated for real
def run_suggest(jinja_src):
    now = dt.datetime(2026, 1, 15, 23, 40)
    st = {
        "input_datetime.eight_sleep_alex_bedtime": {"timestamp": 22 * 3600 + 30 * 60},
        "input_datetime.eight_sleep_alex_winddown": {"timestamp": 23 * 3600},
        "input_datetime.eight_sleep_alex_early": {"timestamp": 23 * 3600 + 50 * 60},
        "input_datetime.eight_sleep_alex_late": {"timestamp": 1 * 3600},
        "input_datetime.eight_sleep_alex_deep": {"timestamp": 3 * 3600},
        "input_datetime.eight_sleep_alex_prewake": {"timestamp": 6 * 3600 + 15 * 60},
        "input_datetime.eight_sleep_alex_wake": {"timestamp": 7 * 3600},
        "weather.home": {"temperature": 4},
        "zone.home": {"latitude": 51.5},
    }
    vals = {"sensor.room_t": "18.5", "sensor.room_h": "40", "sensor.eight_plus_room_temp_rate": "-0.4",
            "sensor.eight_sleep_alex_bed_temp_rate": "1.2", "input_select.eight_sleep_alex_autopilot_response": "Eager"}

    def _float(v, d=0.0):
        try:
            return float(v)
        except (TypeError, ValueError):
            return d

    env = jinja2.Environment(extensions=["jinja2.ext.loopcontrols"])
    env.filters["float"] = _float
    env.filters["int"] = lambda v, d=0: int(_float(v, d))
    env.filters["to_json"] = json.dumps
    env.globals.update(
        now=lambda: now,
        states=lambda e: vals.get(e, "unknown"),
        state_attr=lambda e, a: (st.get(e) or {}).get(a),
        is_state=lambda e, s: vals.get(e) == s,
    )
    env.loader = jinja2.DictLoader({"m": jinja_src})
    out = env.from_string(
        "{% from 'm' import es_suggest %}{{ es_suggest('eight_sleep_alex','sensor.eight_sleep_alex_bed_temp_rate',"
        "'weather.home','sensor.room_t','sensor.room_h','sensor.eight_plus_room_temp_rate') }}").render()
    j = json.loads(out)
    assert 22 <= j["state"] <= 40, j
    assert j["phase"] == "winddown", j  # 23:40 is after 23:00 winddown, before 23:50 early
    assert j["response"] == "Eager"
    out2 = env.from_string("{% from 'm' import hm12 %}{{ hm12('21:05') }}|{{ hm12('00:30:00') }}|{{ hm12('12:00') }}").render()
    assert out2 == "9:05 pm|12:30 am|12:00 pm", out2
    # no weather / room sensors at all -> still a number
    out3 = env.from_string("{% from 'm' import es_suggest %}{{ es_suggest('eight_sleep_alex','x') }}").render()
    assert 22 <= json.loads(out3)["state"] <= 40
    return j


def check_identity(plan, label, a):
    """Each sleeper's bed-temperature sensor carries who they are, for the iPhone app's onboarding:
    name, side, climate, phone (kept even with notifications off), primary and helper prefix."""
    sides = a["bed"]["sides"]
    for i, s in enumerate(plan["summary"]["sleepers"]):
        p = s["prefix"]
        found = None
        for path, text in plan["files"].items():
            if not path.endswith(".yaml"):
                continue
            for block in (yaml.safe_load(text) or {}).get("template") or []:
                for sensor in block.get("sensor") or []:
                    if sensor.get("unique_id") == f"{p}_bed_temperature":
                        found = sensor
        assert found, f"{label}: no {p}_bed_temperature sensor"
        want = {"eight_plus_sleeper": s["name"], "side": a["sleepers"][i]["side"],
                "climate": sides[a["sleepers"][i]["side"]]["climate"],
                "phone": a["sleepers"][i]["notify"], "primary": i == 0, "prefix": p}
        got = found.get("attributes") or {}
        assert got == want, f"{label}: {p} attributes {got!r} != {want!r}"


def answers(bed, backend, couple, feats, sched=None):
    sides = list(bed["sides"])
    sl = [{"name": "Alex", "side": sides[0], "notify": "notify.mobile_app_alex"}]
    if couple and len(sides) > 1:
        sl.append({"name": "Sam O'Neil", "side": sides[1], "notify": ""})
    return {
        "backend": backend, "bed": bed, "sleepers": sl,
        "room": {"weather": "weather.home", "temp": "sensor.bedroom_temperature",
                 "humidity": "sensor.bedroom_humidity"},
        "features": feats,
        "schedule": sched or {"weekday_bed": "22:30", "weekday_wake": "07:00",
                              "weekend_bed": "23:30", "weekend_wake": "08:30"},
        "winddown_scene": "scene.evening",
    }


def main():
    dump = sys.argv[sys.argv.index("--dump") + 1] if "--dump" in sys.argv else None
    reg = json.load(open(os.path.join(FIX, "registry.json")))
    det = D.detect_all(reg, {})
    for b in ("gateway", "freesleep", "cloud"):
        assert det[b], f"fixture registry: {b} not detected"
    # cloud presence comes from the fixture's binary_sensor
    assert det["cloud"]["sides"]["left"].get("presence"), det["cloud"]

    mixes = [
        {"autopilot": True, "smart": True, "coach": True, "notifications": True, "pipeline": True},
        {"autopilot": True, "smart": False, "coach": False, "notifications": True, "pipeline": True},
        {"autopilot": True, "coach": True, "notifications": False, "pipeline": False},
    ]
    total = 0
    for b in ("gateway", "freesleep", "cloud"):
        for couple in (False, True):
            for i, f in enumerate(mixes):
                label = f"{b}/{'couple' if couple else 'solo'}/mix{i}"
                a = answers(det[b], b, couple, f)
                plan = G.build(a, version="test")
                n = check_plan(plan, label)
                check_identity(plan, label, a)
                total += n
                if dump:
                    d = os.path.join(dump, label.replace("/", "_"))
                    for path, text in plan["files"].items():
                        os.makedirs(os.path.dirname(os.path.join(d, path)), exist_ok=True)
                        open(os.path.join(d, path), "w").write(text)
                    json.dump({"cards": plan["cards"], "summary": plan["summary"], "seeds": plan["seeds"]},
                              open(os.path.join(d, "plan.json"), "w"), indent=1, ensure_ascii=False)
                print(f"ok  {label:28} {n:3} automations  {plan['summary']['helpers']:3} helpers")
    # °F Home Assistant: every backend renders, parses and compiles, and every climate write/read
    # crosses the °C⇄°F boundary (a bare °C number reaching a °F climate clamps the bed to 55 °F)
    for b in ("gateway", "freesleep", "cloud"):
        for i, f in enumerate(mixes):
            a = {**answers(det[b], b, True, f), "units": "F"}
            plan = G.build(a, version="test")
            check_plan(plan, f"{b}/imperial/mix{i}")
            for path, text in plan["files"].items():
                if not path.startswith("packages/eight_plus/eight_plus_") or path.endswith("_bed.yaml"):
                    continue
                for line in text.splitlines():
                    if re.search(r"\btemperature:\s", line) and "unit_of_measurement" not in line:
                        assert "* 9 / 5 + 32" in line or re.search(r"temperature:\s*-?\d", line), \
                            f"{b}: unconverted climate write: {line.strip()}"
                assert not re.search(r"state_attr\('climate\.[^']+','(temperature|current_temperature|min_temp|max_temp)'\) \| float\(\d+\)\b(?! - 32)", text), \
                    f"{b}: unconverted climate read"
                assert "device_class: temperature" not in text, f"{b}: °C sensor would be auto-converted to °F"
                assert "temperature: 59.0" in text or "temperature: 15" not in text
            assert "{%- if true -%}" in plan["files"]["custom_templates/eight_plus.jinja"]
        metric = G.build(answers(det[b], b, True, mixes[0]), version="test")
        assert "{%- if false -%}" in metric["files"]["custom_templates/eight_plus.jinja"]
        assert "* 9 / 5 + 32" not in "".join(metric["files"].values()), f"{b}: °C install got °F conversion"
    # the conversion itself: 32 °C bedtime level → 89.6 °F on the wire, 80.6 °F read back → 27 °C
    env = ha_env()
    out = env.from_string("{{ ((32) | float * 9 / 5 + 32) | round(1) }}").render()
    assert out == "89.6", out
    print("ok  °F systems: every climate write/read converted, °C installs untouched")
    # Sleep Coach is deprecated: old answers asking for it must generate nothing coach-related
    plan = G.build(answers(det["gateway"], "gateway", True, mixes[0]), version="test")
    blob = json.dumps(plan["files"]) + json.dumps(plan["cards"])
    assert "_coach" not in blob and "coach_status" not in blob, "deprecated Sleep Coach still generated"
    assert all(c.get("coach") is False for c in plan["cards"].values()), "card still shows the Coach tab"
    print("ok  Sleep Coach deprecated — nothing generated")
    # night spreading edge cases: wraps midnight, short nights, bedtime after midnight
    for bed, wake in (("22:30", "07:00"), ("00:45", "06:00"), ("21:00", "05:00"), ("23:59", "00:30")):
        ph = G.night_phases(bed, wake)
        mins = [(int(ph[k][:2]) * 60 + int(ph[k][3:5]) - G._mins(bed)) % 1440 for k in G.PHASES]
        assert mins == sorted(mins), (bed, wake, ph)
    # validation errors are friendly, not tracebacks
    for bad in ({"backend": "nope"},
                answers(det["gateway"], "gateway", False, mixes[0], {"weekday_bed": "25:00", "weekday_wake": "07:00",
                                                                       "weekend_bed": "23:00", "weekend_wake": "08:00"})):
        try:
            G.build(bad)
            raise AssertionError("expected GenError")
        except G.GenError:
            pass
    j = run_suggest(G._tpl("eight_plus.jinja"))
    print(f"ok  autopilot macro -> {j['state']} °C in phase {j['phase']}")
    print(f"ALL GOOD — {total} automations rendered and checked")


if __name__ == "__main__":
    main()
