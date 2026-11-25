"""
Eight+ generator — turns onboarding answers into Home Assistant config.

Pure functions, no I/O beyond reading the bundled templates, so the whole install can be
rendered and checked offline (tests/test_generator.py) before anything touches HA.

    plan = build(answers, version="0.1.0")
    plan["files"]        {relative path under /config: text}
    plan["seeds"]        [(service, data)] — initial helper values, applied once
    plan["cards"]        {slug: card config dict}
    plan["dashboard"]    lovelace config dict
    plan["entities"]     every entity id this install creates (for collision checks)
    plan["summary"]      counts for the review screen
"""
import json
import os
import re
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
TPL_DIR = os.path.join(HERE, "templates")

PHASES = ["bedtime", "winddown", "early", "late", "deep", "prewake", "wake"]
PHASE_LEVEL = {"bedtime": 32, "winddown": 30, "early": 28, "late": 27, "deep": 26,
               "prewake": 30, "wake": 35}
# Autopilot per-phase offsets — the model's built-in defaults, promoted to helpers
PHASE_OFFSET = {"bedtime": 2, "winddown": 1, "early": 0.5, "late": -1, "deep": -2.5,
                "prewake": 0.5, "wake": 2}
BACKEND_LABEL = {
    "gateway": "Eight+ Pod gateway (local MQTT, stock firmware)",
    "freesleep": "free-sleep firmware (hass-free-sleep integration)",
    "cloud": "Eight Sleep cloud (eight_sleep custom integration)",
}

# Card art — the photo bed + hand-traced glow outlines (see the card repo's tools/box-tuner.html)
CARD_ART = {
    "mid_temp": 27,
    "pillow_style": "top:-10.7%; left:18.8%; width:62%;",
    "pillow_shadow": "drop-shadow(0 8px 3px rgba(0,0,0,0.65)) drop-shadow(0 20px 8px rgba(0,0,0,0.43))",
    # the tuned 28-point mattress outline (same as tools/sync_card.py BED_ART); the rounded
    # half outlines are the card's own defaults
    "glow_poly": "22.1% 13.3%, 22.2% 13.0%, 22.3% 12.8%, 22.5% 12.6%, 22.7% 12.5%, 23.0% 12.5%, 23.4% 12.4%, "
                 "75.7% 11.8%, 76.1% 11.8%, 76.4% 11.9%, 76.6% 12.0%, 76.8% 12.1%, 76.9% 12.3%, 77.0% 12.6%, "
                 "85.3% 53.3%, 85.3% 53.5%, 85.2% 53.8%, 85.1% 53.9%, 84.8% 54.0%, 84.5% 54.1%, 84.0% 54.1%, "
                 "15.1% 53.9%, 14.7% 53.9%, 14.4% 53.8%, 14.1% 53.7%, 13.9% 53.5%, 13.9% 53.3%, 13.9% 53.1%",
}


class GenError(ValueError):
    pass


# ───────────────────────────────────────────────────────────────── helpers
def slugify(text):
    """Close to HA's slugify for the names we allow (latin letters, digits, spaces, - . ')."""
    t = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode()
    t = re.sub(r"[^a-z0-9]+", "_", t.lower()).strip("_")
    return re.sub(r"_+", "_", t)


def clean_name(name):
    """Names end up inside YAML strings and notification titles — keep them boring."""
    n = re.sub(r"[^\w .\-']", "", str(name or ""), flags=re.UNICODE).strip()
    n = n.replace("'", "’")  # typographic apostrophe: safe inside single-quoted Jinja
    return n[:24] or "Sleeper"


def _hm(minutes):
    minutes %= 1440
    return "%02d:%02d:00" % (minutes // 60, minutes % 60)


def _mins(hhmm):
    m = re.match(r"^(\d{1,2}):(\d{2})", str(hhmm or ""))
    if not m:
        raise GenError(f"bad time {hhmm!r} (want HH:MM)")
    h, mi = int(m.group(1)), int(m.group(2))
    if h > 23 or mi > 59:
        raise GenError(f"bad time {hhmm!r}")
    return h * 60 + mi


def _r5(m):
    return int(round(m / 5.0) * 5)


def night_phases(bed, wake):
    """Spread the seven Autopilot phases across a night, the shape the model expects:
    bedtime -> winddown -> early -> late -> deep -> prewake -> wake (all relative to bedtime)."""
    b, w = _mins(bed), _mins(wake)
    span = (w - b) % 1440 or 480
    pre = max(span - 45, int(span * 0.85))
    rel = {"bedtime": 0, "winddown": _r5(span * 0.06), "early": _r5(span * 0.16),
           "late": _r5(span * 0.30), "deep": _r5(span * 0.55), "prewake": _r5(pre), "wake": span}
    return {k: _hm(b + v) for k, v in rel.items()}


# ───────────────────────────────────────────────────────────────── templating
_IF = re.compile(r"^\s*#if\s+(.+?)\s*$")
_ENDIF = re.compile(r"^\s*#endif\s*$")
_VAR = re.compile(r"\$\{([A-Z0-9_]+)\}")


def _eval_flag(expr, flags):
    toks = expr.replace("(", " ( ").replace(")", " ) ").split()
    py = []
    for t in toks:
        if t in ("and", "or", "not", "(", ")"):
            py.append(t)
        elif t.startswith("!"):
            py.append(f"not {bool(flags.get(t[1:]))}")
        elif re.fullmatch(r"[a-z_][a-z0-9_]*", t):
            if t not in flags:
                raise GenError(f"template flag {t!r} is not defined")
            py.append(str(bool(flags[t])))
        else:
            raise GenError(f"bad token {t!r} in #if {expr}")
    return eval(" ".join(py), {"__builtins__": {}}, {})  # noqa: S307 — tokens whitelisted above


def render(text, flags, vars_):
    """`#if <expr>` / `#endif` line blocks (nestable) then ${VAR} substitution. Unknown
    flags or variables are errors, not blanks — a typo must never ship silently."""
    out, stack = [], []
    for line in text.splitlines():
        m = _IF.match(line)
        if m:
            stack.append(_eval_flag(m.group(1), flags))
            continue
        if _ENDIF.match(line):
            if not stack:
                raise GenError("#endif without #if")
            stack.pop()
            continue
        if all(stack):
            out.append(line)
    if stack:
        raise GenError("unclosed #if")

    def sub(m):
        k = m.group(1)
        if k not in vars_:
            raise GenError(f"template variable ${{{k}}} is not defined")
        return str(vars_[k])

    body = _VAR.sub(sub, "\n".join(out)) + "\n"
    # an `automation:` key with nothing under it (every block switched off) is invalid YAML for HA
    body = re.sub(r"(?m)^automation:\n(?=\S|\Z)", "", body)
    return body


def _tpl(name):
    with open(os.path.join(TPL_DIR, name), encoding="utf-8") as f:
        return f.read()


def _q(s):
    """A YAML double-quoted scalar."""
    return json.dumps(str(s), ensure_ascii=False)


# ───────────────────────────────────────────────────────────────── helpers table
def helper_table(p, name, sched, feat, backend):
    """Every input_* / counter helper for one sleeper, with its first-run value.
    Returns [(domain, object_id, config, seed)] — seed is (service, data) or None."""
    H = []

    def b(key, label, icon, on=None):
        eid = f"input_boolean.{p}_{key}"
        seed = None if on is None else (f"input_boolean.turn_{'on' if on else 'off'}", {"entity_id": eid})
        H.append(("input_boolean", f"{p}_{key}", {"name": f"{name} {label}", "icon": icon}, seed))

    def n(key, label, lo, hi, step, unit, val, mode="box", icon=None):
        cfg = {"name": f"{name} {label}", "min": lo, "max": hi, "step": step, "mode": mode}
        if unit:
            cfg["unit_of_measurement"] = unit
        if icon:
            cfg["icon"] = icon
        H.append(("input_number", f"{p}_{key}", cfg,
                  ("input_number.set_value", {"entity_id": f"input_number.{p}_{key}", "value": val})))

    def t(key, label, val, icon="mdi:clock-outline", date=False):
        cfg = {"name": f"{name} {label}", "has_date": date, "has_time": True, "icon": icon}
        seed = None if val is None else (
            "input_datetime.set_datetime", {"entity_id": f"input_datetime.{p}_{key}", "time": val})
        H.append(("input_datetime", f"{p}_{key}", cfg, seed))

    def s(key, label, options, val, icon):
        H.append(("input_select", f"{p}_{key}", {"name": f"{name} {label}", "options": options, "icon": icon},
                  ("input_select.select_option", {"entity_id": f"input_select.{p}_{key}", "option": val})))

    ph = night_phases(sched["weekday_bed"], sched["weekday_wake"])
    wake_m = _mins(sched["weekday_wake"])

    # ---- the bed, every feature needs these
    b("away_mode", "Away mode", "mdi:airplane", False)
    b("boost_active", "Boost active", "mdi:rocket-launch", False)
    t("boost_until", "Boost until", None, "mdi:timer-sand", date=True)
    b("off_when_up", "Off when up", "mdi:bed-clock", True)
    b("light_alarm", "Sunrise light", "mdi:weather-sunset-up", False)
    H.append(("input_text", f"{p}_alarm_light", {"name": f"{name} Sunrise light entity", "max": 100,
                                                  "icon": "mdi:lightbulb-on-outline"}, None))
    # ---- schedule (7 phases × time + level) + routine + auto-off
    for k in PHASES:
        t(k, f"{k.capitalize()} time", ph[k])
        n(f"{k}_level", f"{k.capitalize()} temperature", 13, 43, 0.5, "°C", PHASE_LEVEL[k], "slider",
          "mdi:thermometer")
    t("weekday_bedtime", "Weekday bedtime", _hm(_mins(sched["weekday_bed"])), "mdi:bed-clock")
    t("weekday_alarm", "Weekday wake", _hm(_mins(sched["weekday_wake"])), "mdi:alarm")
    t("weekend_bedtime", "Weekend bedtime", _hm(_mins(sched["weekend_bed"])), "mdi:bed-clock")
    t("weekend_alarm", "Weekend wake", _hm(_mins(sched["weekend_wake"])), "mdi:alarm")
    b("auto_off_enabled", "Auto-off", "mdi:power-sleep", True)
    t("auto_off", "Auto-off time", _hm(wake_m + 60), "mdi:power-sleep")
    # ---- Smart Autopilot + tuning
    b("smart_autopilot", "Smart Autopilot", "mdi:thermostat-auto", bool(feat.get("smart")))
    n("smart_bias", "Autopilot bias", -6, 6, 0.5, "°C", 0, icon="mdi:tune-variant")
    n("autopilot_min", "Autopilot minimum", 13, 43, 0.5, "°C", 22)
    n("autopilot_max", "Autopilot maximum", 13, 43, 0.5, "°C", 40)
    n("ap_tick", "Autopilot cadence", 1, 15, 1, "min", 2, icon="mdi:timer-cog-outline")
    n("ap_deadband", "Autopilot deadband", 0.1, 2, 0.05, "°C", 0.25)
    s("autopilot_response", "Autopilot response", ["Gentle", "Balanced", "Eager"], "Balanced",
      "mdi:speedometer")
    for k in PHASES:
        n(f"ap_offset_{k}", f"Autopilot {k} offset", -6, 6, 0.5, "°C", PHASE_OFFSET[k])
    for key, label in (("forecast", "uses forecast"), ("room", "uses room temp"),
                       ("humidity", "uses humidity"), ("reactive", "reactive"),
                       ("preconditioning", "pre-conditions")):
        b(f"ap_use_{key}", f"Autopilot {label}", "mdi:tune", True)
    # ---- Sleep Coach (deprecated — build() always passes coach=False; kept for reference)
    if feat.get("coach"):
        b("coach", "Sleep Coach", "mdi:shield-check", True)
        b("pull_earlier", "Coach pulls bedtime earlier", "mdi:arrow-collapse-left", False)
        b("coach_off_tonight", "Coach off tonight", "mdi:sleep-off", False)
        b("wake_ack", "Up acknowledged", "mdi:check", False)
        b("wake_heat", "Wake with heat", "mdi:fire", True)
        b("wake_vibrate", "Wake with vibration", "mdi:vibrate", backend == "gateway")
        b("wake_phone", "Wake with phone alert", "mdi:cellphone", bool(feat.get("notify")))
        b("wake_cold", "Wake cold snap", "mdi:snowflake", False)
        b("wake_sound", "Wake sound", "mdi:volume-high", False)
        b("nudge_winddown", "Nudge at wind-down", "mdi:bell-sleep", True)
        b("nudge_pre", "Nudge 15 min before", "mdi:bell", True)
        b("nudge_late", "Nudge when late", "mdi:bell-alert", True)
        b("nudge_loud", "Loud late nudges", "mdi:bell-ring", False)
        t("target_bedtime", "Target bedtime", _hm(_mins(sched["weekday_bed"])), "mdi:bed-clock")
        t("target_bedtime_weekend", "Target bedtime (weekend)", _hm(_mins(sched["weekend_bed"])), "mdi:bed-clock")
        t("target_wake", "Target wake", _hm(_mins(sched["weekday_wake"])), "mdi:alarm")
        t("target_wake_weekend", "Target wake (weekend)", _hm(_mins(sched["weekend_wake"])), "mdi:alarm")
        t("coach_tonight_target", "Coach tonight's target", _hm(_mins(sched["weekday_bed"])), "mdi:target")
        n("sleep_need", "Sleep need", 5, 10, 0.25, "h", 8, icon="mdi:sleep")
        n("winddown_lead", "Wind-down lead", 0, 120, 5, "min", 45, icon="mdi:weather-night")
        n("green_window", "On-time window", 5, 60, 5, "min", 15, icon="mdi:check-circle-outline")
        s("wake_strength", "Wake strength", ["Off", "Gentle", "Firm", "Relentless"], "Firm", "mdi:alarm-light")
        H.append(("counter", f"{p}_coach_nudges", {"name": f"{name} Coach nudges", "initial": 0, "step": 1,
                                                    "restore": True, "icon": "mdi:counter"}, None))
    return H


def helpers_yaml(table):
    by = {}
    for dom, oid, cfg, _seed in table:
        by.setdefault(dom, []).append((oid, cfg))
    lines = []
    for dom in ("input_boolean", "input_number", "input_datetime", "input_select", "input_text", "counter"):
        if dom not in by:
            continue
        lines.append(f"{dom}:")
        for oid, cfg in by[dom]:
            lines.append(f"  {oid}:")
            for k, v in cfg.items():
                if isinstance(v, bool):
                    v = "true" if v else "false"
                elif isinstance(v, list):
                    v = "[" + ", ".join(_q(x) for x in v) + "]"
                elif isinstance(v, str):
                    v = _q(v)
                lines.append(f"    {k}: {v}")
        lines.append("")
    return "\n".join(lines)


# ───────────────────────────────────────────────────────────────── backend expressions
def _bed_exprs(backend, bed):
    sh = bed.get("shared") or {}
    if backend == "cloud":
        water = sh.get("has_water")
        prim = sh.get("is_priming")
        water_tpl = f"states('{water}') in ['False','false','off']" if water else "false"
        prim_tpl = f"states('{prim}') in ['True','true','on']" if prim else "false"
    else:
        water = sh.get("water_low")
        prim = sh.get("priming")
        water_tpl = f"is_state('{water}','on')" if water else "false"
        prim_tpl = f"is_state('{prim}','on')" if prim else "false"
    return water_tpl, prim_tpl


def _prime_action(backend, bed, primary_side):
    sh = bed.get("shared") or {}
    ind = " " * 14
    if sh.get("prime_button"):
        return f"{ind}- action: button.press\n{ind}  target: {{entity_id: {sh['prime_button']}}}"
    side = (bed.get("sides") or {}).get(primary_side) or {}
    if backend == "cloud" and side.get("side_sensor"):
        return f"{ind}- action: eight_sleep.prime_pod\n{ind}  target: {{entity_id: {side['side_sensor']}}}"
    return f"{ind}- action: persistent_notification.create\n{ind}  data: {{message: \"Prime from the Eight Sleep app — this backend has no prime control.\"}}"


def _bed_temp(backend, side, imperial=False):
    if backend == "cloud" and side.get("bed_temp"):
        e = side["bed_temp"]
        v = f"states('{e}') | float(0)"
        # a °C temperature sensor is shown in °F on a °F system — bring it back to °C
        return (f"(({v}) - 32) * 5 / 9" if imperial else v), f"has_value('{e}')"
    c = side["climate"]
    return (f"state_attr('{c}','current_temperature') | float(0)",
            f"state_attr('{c}','current_temperature') is number")


# ── °F Home Assistant systems ────────────────────────────────────────────────────────────
# Eight+ thinks in °C end to end: every helper, the Autopilot model, the card. Home Assistant
# speaks the SYSTEM unit at its climate entities (and weather/room sensors), so on a °F system
# the generated YAML converts at that boundary — every value written to a climate goes °C → °F,
# every climate temperature attribute read comes back °F → °C. Done as a pass over the rendered
# YAML so no automation can be missed; on a °C system the output is byte-for-byte unchanged.
_RD_CLIMATE = re.compile(
    r"state_attr\('(climate\.[^']+)',\s*'(temperature|current_temperature|min_temp|max_temp)'\)\s*\|\s*float\((-?[\d.]+)\)")
_RD_TRIGGER = re.compile(r"trigger\.(from|to)_state\.attributes\.temperature\s*\|\s*float\((-?[\d.]+)\)")
_WR_TEMPLATE = re.compile(r'(\btemperature:\s*)"\{\{\s*(.*?)\s*\}\}"')
_WR_NUMBER = re.compile(r"(\btemperature:\s*)(-?\d+(?:\.\d+)?)(?=\s*[}\n])")


def _c2f(c):
    return round(float(c) * 9 / 5 + 32, 1)


def _to_imperial(text):
    # reads first (the writes below wrap expressions that contain reads)
    text = _RD_CLIMATE.sub(lambda m: f"((state_attr('{m.group(1)}','{m.group(2)}') | float({_c2f(m.group(3))}) - 32) * 5 / 9)", text)
    text = _RD_TRIGGER.sub(lambda m: f"((trigger.{m.group(1)}_state.attributes.temperature | float({_c2f(m.group(2))}) - 32) * 5 / 9)", text)
    text = _WR_TEMPLATE.sub(lambda m: f'{m.group(1)}"{{{{ (({m.group(2)}) | float * 9 / 5 + 32) | round(1) }}}}"', text)
    text = _WR_NUMBER.sub(lambda m: f"{m.group(1)}{_c2f(m.group(2))}", text)
    return text


# ───────────────────────────────────────────────────────────────── build
def validate(a):
    if a.get("backend") not in BACKEND_LABEL:
        raise GenError("pick a backend")
    sides = (a.get("bed") or {}).get("sides") or {}
    sl = a.get("sleepers") or []
    if not 1 <= len(sl) <= 2:
        raise GenError("one or two sleepers")
    seen = set()
    for s in sl:
        if s.get("side") not in sides or not sides[s["side"]].get("climate"):
            raise GenError(f"{s.get('name')!r}: no climate entity found for the {s.get('side')} side")
        if s["side"] in seen:
            raise GenError("two sleepers can't share a side")
        seen.add(s["side"])
        if not sides[s["side"]].get("presence"):
            raise GenError(f"{s.get('name')!r}: no bed-presence sensor on the {s['side']} side")
    slugs = [slugify(clean_name(s["name"])) for s in sl]
    if len(set(slugs)) != len(slugs):
        raise GenError("the two names need to be different")
    for k in ("weekday_bed", "weekday_wake", "weekend_bed", "weekend_wake"):
        _mins((a.get("schedule") or {}).get(k))


def build(a, version="0.0.0"):
    validate(a)
    backend = a["backend"]
    bed = a["bed"]
    sides = bed["sides"]
    feat = dict(a.get("features") or {})
    # Sleep Coach is deprecated: never generated, even from older saved answers, so re-running
    # setup on an install that had it removes its helpers, automations and card tab.
    feat["coach"] = False
    room = a.get("room") or {}
    sched = a["schedule"]
    dash = a.get("dashboard") or {}
    dash_path = dash.get("url_path") or "eight-plus"
    asset = (a.get("asset_base") or "/local/eight_plus").rstrip("/")
    two_climates = sum(1 for s in sides.values() if s.get("climate")) >= 2
    # the HA system temperature unit, stamped into the answers by the installer ("C" if absent)
    imperial = a.get("units") == "F"

    sleepers = []
    for i, s in enumerate(a["sleepers"]):
        name = clean_name(s["name"])
        slug = slugify(name)
        sleepers.append({"name": name, "slug": slug, "p": f"eight_sleep_{slug}", "side": s["side"],
                         "notify": s.get("notify") or "", "primary": i == 0})
    if feat.get("notifications") is False:
        for s in sleepers:
            s["notify"] = ""
    primary = sleepers[0]

    water_tpl, prim_tpl = _bed_exprs(backend, bed)
    bed_flags = {"two_climates": two_climates, "room_temp": bool(room.get("temp")),
                 "gateway": backend == "gateway", "notify_primary": bool(primary["notify"])}
    bed_vars = {"VERSION": version, "BACKEND_LABEL": BACKEND_LABEL[backend], "WATER_LOW_TPL": water_tpl,
                "PRIMING_TPL": prim_tpl, "ROOM_T": room.get("temp") or "",
                "NOTIFY_PRIMARY": primary["notify"] or "notify.notify"}
    files = {"packages/eight_plus/eight_plus_bed.yaml": render(_tpl("bed.yaml.tmpl"), bed_flags, bed_vars),
             "custom_templates/eight_plus.jinja": _tpl("eight_plus.jinja").replace(
                 "__EP_IMPERIAL__", "true" if imperial else "false")}

    all_climates = [sd["climate"] for sd in sides.values() if sd.get("climate")]
    seeds, entities, cards, summary_rows = [], [], {}, []
    for s in sleepers:
        p, side = s["p"], sides[s["side"]]
        other = next((o for o in sleepers if o is not s), None)
        other_side_key = next((k for k in sides if k != s["side"] and sides[k].get("climate")), None)
        own_c = side["climate"]
        partner_c = sides[other_side_key]["climate"] if other_side_key else ""
        if s["primary"] and partner_c:
            beds = f"['{own_c}'] + (['{partner_c}'] if is_state('input_boolean.eight_plus_dual_mode','off') else [])"
            solo_note = (f" In Solo (dual mode off) it drives BOTH halves; in Dual only {s['side']}.")
        else:
            beds = f"['{own_c}']"
            solo_note = " Dual mode only — in Solo the primary sleeper drives the whole bed." if partner_c else ""
        any_on = ("[" + ", ".join(f"'{c}'" for c in all_climates) + "] | map('states') | "
                  "reject('in', ['off', 'unavailable', 'unknown']) | list | count > 0")
        table = helper_table(p, s["name"], sched, {**feat, "notify": bool(s["notify"])}, backend)
        bt_tpl, bt_avail = _bed_temp(backend, side, imperial)
        score = f"sensor.{p}_sleep_score" if feat.get("pipeline", True) else ""
        scene = (a.get("winddown_scene") or "").strip()
        flags = {
            "autopilot": feat.get("autopilot", True), "coach": bool(feat.get("coach")),
            "notify": bool(s["notify"]), "primary": s["primary"],
            "secondary": (not s["primary"]) and bool(partner_c),
            "gateway": backend == "gateway", "led": backend == "gateway" and bool((bed.get("shared") or {}).get("led")),
            "winddown_scene": bool(scene), "imperial": imperial,
        }
        v = {
            "VERSION": version, "NAME": s["name"], "SLUG": s["slug"], "P": p, "UP": s["slug"].upper(),
            "SIDE": s["side"], "ROLE_NOTE": ", primary" if s["primary"] and len(sleepers) > 1 else "",
            "CLIMATE": own_c, "BEDS": beds, "ANY_ON": any_on, "SOLO_DUAL_NOTE": solo_note,
            "AWAY": f"input_boolean.{p}_away_mode", "PRESENCE": side["presence"],
            "NOTIFY": s["notify"] or "notify.notify", "SCORE": score or f"sensor.{p}_sleep_score",
            "WEATHER": room.get("weather") or "", "DASH_URL": f"/{dash_path}/{s['slug']}",
            "BED_TEMP_TPL": bt_tpl, "BED_TEMP_AVAIL": bt_avail,
            "SUGGEST_ARGS": ", ".join(_q(x).replace('"', "'") for x in (
                p, f"sensor.{p}_bed_temp_rate", room.get("weather") or "", room.get("temp") or "",
                room.get("humidity") or "", "sensor.eight_plus_room_temp_rate" if room.get("temp") else "")),
            "HELPERS_YAML": helpers_yaml(table),
            "PRIME_ACTION": _prime_action(backend, bed, s["side"]),
            "WINDDOWN_SCENE": scene, "WINDDOWN_SCENE_ACTION": ("scene.turn_on" if scene.startswith("scene.")
                                                               else "script.turn_on"),
        }
        text = render(_tpl("sleeper.yaml.tmpl"), flags, v)
        files[f"packages/eight_plus/eight_plus_{s['slug']}.yaml"] = _to_imperial(text) if imperial else text
        seeds += [sd for *_x, sd in table if sd]
        entities += [f"{d}.{o}" for d, o, _c, _s in table]
        entities += [f"sensor.{p}_bed_temperature", f"sensor.{p}_bed_temp_rate",
                     f"sensor.{p}_bed_occupancy_15m", f"binary_sensor.{p}_in_bed", f"script.{p}_wind_down"]
        if flags["autopilot"]:
            entities.append(f"sensor.{p}_suggested_temp")
        if flags["coach"]:
            entities.append(f"sensor.{p}_coach_status")
        cards[s["slug"]] = card_config(a, s, other, sides, other_side_key, asset, feat)
        summary_rows.append({"name": s["name"], "side": s["side"], "prefix": p, "helpers": len(table),
                             "automations": files[f"packages/eight_plus/eight_plus_{s['slug']}.yaml"].count("\n  - id: "),
                             "notify": s["notify"]})
    if two_climates:
        entities.append("input_boolean.eight_plus_dual_mode")
        seeds.insert(0, ("input_boolean.turn_off" if len(sleepers) == 1 else "input_boolean.turn_on",
                         {"entity_id": "input_boolean.eight_plus_dual_mode"}))
    entities += ["binary_sensor.eight_plus_water_low", "binary_sensor.eight_plus_priming"]
    if room.get("temp"):
        entities.append("sensor.eight_plus_room_temp_rate")

    dashboard = {"title": dash.get("title") or "Eight+", "views": [
        {"title": s["name"], "path": s["slug"], "icon": "mdi:bed", "type": "panel",
         "cards": [cards[s["slug"]]]} for s in sleepers]}
    summary = {
        "backend": BACKEND_LABEL[backend], "sleepers": summary_rows,
        "helpers": sum(r["helpers"] for r in summary_rows) + (1 if two_climates else 0),
        "automations": sum(r["automations"] for r in summary_rows) + files["packages/eight_plus/eight_plus_bed.yaml"].count("\n  - id: "),
        "template_sensors": sum(3 + (1 if feat.get("autopilot", True) else 0) + (1 if feat.get("coach") else 0)
                                for _ in sleepers) + 2,
        "files": sorted(files),
        "schedule": {s["name"]: night_phases(sched["weekday_bed"], sched["weekday_wake"]) for s in sleepers},
    }
    return {"files": files, "seeds": seeds, "cards": cards, "dashboard": dashboard,
            "entities": sorted(set(entities)), "summary": summary,
            "sleepers": [{k: s[k] for k in ("name", "slug", "p", "side", "notify", "primary")} for s in sleepers]}


def card_config(a, s, other, sides, other_side_key, asset, feat):
    backend = a["backend"]
    room = a.get("room") or {}
    sh = (a["bed"].get("shared") or {})
    p = s["p"]
    op = other["p"] if other else ""
    side = sides[s["side"]]
    oside = sides.get(other_side_key) or {} if other_side_key else {}
    gw, fs, cl = backend == "gateway", backend == "freesleep", backend == "cloud"
    pipeline = feat.get("pipeline", True)

    def pe(fmt):  # partner helper, or "" when there's no second sleeper
        return fmt.format(op) if op else ""

    c = {
        "type": "custom:eight-sleep-card",
        "layout": "v2",
        "source": backend,
        "title": "Your Pod", "pod_name": "Your Pod",
        "side": s["side"].capitalize(), "own_side": s["side"], "own_label": "You",
        "partner_name": other["name"] if other else "Other side",
        "partner_label": other["name"] if other else "Other side",
        "entity": side["climate"],
        "current_temp_entity": f"sensor.{p}_bed_temperature",
        "partner_climate_entity": oside.get("climate") or "",
        "dual_mode_entity": "input_boolean.eight_plus_dual_mode" if oside.get("climate") else "",
        "side_state_entity": False, "partner_side_entity": False,
        "bed_state_entity": side.get("bed_state") or False,
        "partner_bed_state_entity": oside.get("bed_state") or False,
        "alarm_entity": side.get("next_alarm") or False,
        "away_entity": f"input_boolean.{p}_away_mode",
        "partner_away_entity": pe("input_boolean.{}_away_mode") or False,
        "vacation_entity": f"input_boolean.{p}_away_mode",
        # water / priming — normalised by the bed package
        "priming_entity": "binary_sensor.eight_plus_priming",
        "has_water_entity": "binary_sensor.eight_plus_water_low", "has_water_invert": True,
        "need_priming_entity": False, "last_prime_entity": False,
        "prime_button_entity": sh.get("prime_button") or False,
        "prime_target_entity": (side.get("side_sensor") or False) if cl else False,
        # biometrics
        "presence_entity": side.get("presence") or False,
        "partner_presence_entity": oside.get("presence") or False,
        "heart_rate_entity": side.get("heart_rate") or False,
        "hrv_entity": side.get("hrv") or False,
        "breath_rate_entity": side.get("breath_rate") or False,
        "partner_heart_rate_entity": oside.get("heart_rate") or False,
        "partner_hrv_entity": oside.get("hrv") or False,
        "partner_breath_rate_entity": oside.get("breath_rate") or False,
        "biometrics_toggle_entity": sh.get("biometrics_toggle") or False,
        "sleep_score_entity": f"sensor.{p}_sleep_score" if pipeline else False,
        "partner_sleep_score_entity": (pe("sensor.{}_sleep_score") or False) if pipeline else False,
        "water_temp_entity": side.get("water_temp") or "",
        "partner_water_temp_entity": oside.get("water_temp") or "",
        # schedule + Autopilot (this sleeper) …
        "schedule_prefix": p,
        "smart_entity": f"input_boolean.{p}_smart_autopilot",
        "smart_bias_entity": f"input_number.{p}_smart_bias",
        "suggested_entity": f"sensor.{p}_suggested_temp",
        "auto_off_entity": f"input_datetime.{p}_auto_off",
        "auto_off_toggle_entity": f"input_boolean.{p}_auto_off_enabled",
        "boost_active_entity": f"input_boolean.{p}_boost_active",
        "boost_until_entity": f"input_datetime.{p}_boost_until",
        "bed_rate_entity": f"sensor.{p}_bed_temp_rate",
        "winddown_script": f"script.{p}_wind_down",
        "off_when_up_entity": f"input_boolean.{p}_off_when_up",
        "in_bed_entity": f"binary_sensor.{p}_in_bed",
        "ap_response_entity": f"input_select.{p}_autopilot_response",
        "ap_min_entity": f"input_number.{p}_autopilot_min",
        "ap_max_entity": f"input_number.{p}_autopilot_max",
        "ap_tick_entity": f"input_number.{p}_ap_tick",
        "ap_deadband_entity": f"input_number.{p}_ap_deadband",
        "ap_offset_prefix": f"input_number.{p}_ap_offset",
        "ap_signals": [
            {"key": "forecast", "label": "Outside forecast", "entity": f"input_boolean.{p}_ap_use_forecast"},
            {"key": "room", "label": "Room temperature", "entity": f"input_boolean.{p}_ap_use_room"},
            {"key": "humidity", "label": "Humidity", "entity": f"input_boolean.{p}_ap_use_humidity"},
            {"key": "reactive", "label": "Reactive corrections", "entity": f"input_boolean.{p}_ap_use_reactive"},
            {"key": "precon", "label": "Pre-conditioning", "entity": f"input_boolean.{p}_ap_use_preconditioning"},
        ],
        "weekday_bedtime_entity": f"input_datetime.{p}_weekday_bedtime",
        "weekday_alarm_entity": f"input_datetime.{p}_weekday_alarm",
        "weekend_bedtime_entity": f"input_datetime.{p}_weekend_bedtime",
        "weekend_alarm_entity": f"input_datetime.{p}_weekend_alarm",
        "alarm_light_toggle_entity": f"input_boolean.{p}_light_alarm",
        "alarm_light_select_entity": f"input_text.{p}_alarm_light",
        # … and the partner's
        "partner_schedule_prefix": op,
        "partner_smart_entity": pe("input_boolean.{}_smart_autopilot"),
        "partner_smart_bias_entity": pe("input_number.{}_smart_bias"),
        "partner_suggested_entity": pe("sensor.{}_suggested_temp"),
        "partner_auto_off_entity": pe("input_datetime.{}_auto_off"),
        "partner_auto_off_toggle_entity": pe("input_boolean.{}_auto_off_enabled"),
        "partner_boost_active_entity": pe("input_boolean.{}_boost_active"),
        "partner_boost_until_entity": pe("input_datetime.{}_boost_until"),
        "partner_bed_rate_entity": pe("sensor.{}_bed_temp_rate"),
        # room
        "weather_entity": room.get("weather") or "",
        "room_temp_entity": room.get("temp") or "",
        "room_humidity_entity": room.get("humidity") or "",
        "pm25_entity": room.get("pm25") or "",
        "underglow_entity": "", "underglow_auto_entity": "", "wake_focus_entity": "",
        # Coach
        "coach": bool(feat.get("coach")), "coach_prefix": p,
        # gateway extras (Developer screen, Pod health, vibration)
        "dev_view": gw, "dev_prefix": "eight_sleep_pod",
        "health_entity": sh.get("health") or False,
        "reboot_entity": sh.get("reboot") or False,
        "restart_control_entity": sh.get("restart_control") or False,
        "auto_repair_entity": sh.get("auto_repair") or False,
        "headroom_room_entity": sh.get("pod_room_temp") or False,
        "vibrate_script": "script.eight_sleep_pod_vibrate" if gw else "",
        # art
        "bed_image": f"{asset}/es-bed.png", "pillow_image": f"{asset}/es-pillows.png",
        "font_url": False,
        **CARD_ART,
    }
    if gw or fs:
        # local backends take half-degrees straight through climate.set_temperature
        c["half_degree_via_heat_set"] = False
    return c
