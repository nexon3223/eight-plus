"""
Backend detection — finds the Pod in Home Assistant's entity registry.

Matching is on each integration's own unique_id scheme, never on entity_id, so a user who
renamed "climate.pod_3_left_temperature" to "climate.bed_left" is still found.

    detect_all(registry, states) -> {"gateway": {...}|None, "freesleep": {...}|None, "cloud": {...}|None}

Each hit: {"backend", "label", "sides": {"left": {...}, "right": {...}}, "shared": {...},
           "notes": [...], "ssh_capable": bool}
"""
import re

SIDE_KEYS = ("climate", "presence", "heart_rate", "hrv", "breath_rate", "bed_temp", "water_temp",
             "side_sensor", "bed_state", "next_alarm")


def _by_uid(registry, platform):
    return {e.get("unique_id"): e for e in registry
            if e.get("platform") == platform and e.get("unique_id") and not e.get("disabled_by")}


def _eid(e):
    return e["entity_id"] if e else None


def _hit(backend, label, sides, shared, notes=None, ssh=False):
    sides = {k: {kk: vv for kk, vv in v.items() if vv} for k, v in sides.items()}
    sides = {k: v for k, v in sides.items() if v.get("climate")}
    if not sides:
        return None
    return {"backend": backend, "label": label, "sides": sides,
            "shared": {k: v for k, v in shared.items() if v}, "notes": notes or [], "ssh_capable": ssh}


# ─────────────────────────────────────────────── Eight+ Pod gateway (MQTT discovery)
def detect_gateway(registry):
    u = _by_uid(registry, "mqtt")
    if "eight_pod_ctl_left" not in u and "eight_pod_ctl_right" not in u:
        return None
    sides = {}
    for s in ("left", "right"):
        sides[s] = {
            "climate": _eid(u.get(f"eight_pod_ctl_{s}")),
            "presence": _eid(u.get(f"eight_pod_bio_{s}_present")),
            "heart_rate": _eid(u.get(f"eight_pod_bio_{s}_heart_rate")),
            "hrv": _eid(u.get(f"eight_pod_bio_{s}_hrv")),
            "breath_rate": _eid(u.get(f"eight_pod_bio_{s}_breathing_rate")),
            "water_temp": _eid(u.get(f"eight_pod_bio_{s}_water_temp")),
        }
    shared = {
        "water_low": _eid(u.get("eight_pod_ctl_water_low")),
        "priming": _eid(u.get("eight_pod_ctl_priming")),
        "prime_button": _eid(u.get("eight_pod_ctl_prime")),
        "health": _eid(u.get("eight_pod_wd_health")),
        "reboot": _eid(u.get("eight_pod_wd_reboot")),
        "restart_control": _eid(u.get("eight_pod_wd_restart_control")),
        "auto_repair": _eid(u.get("eight_pod_wd_auto_repair")),
        "led": _eid(u.get("eight_pod_led")),
        "pod_room_temp": _eid(u.get("eight_pod_bio_room_temperature")),
    }
    notes = []
    if not any(sides[s].get("presence") for s in sides):
        notes.append("No bed-presence sensors — install pod-biometrics-tap on the Pod for presence, "
                     "vitals and the Sleep tab.")
    if not shared.get("health"):
        notes.append("No es-watchdog — the Pod health light and auto-repair stay hidden.")
    return _hit("gateway", "Eight+ Pod gateway", sides, shared, notes, ssh=True)


# ─────────────────────────────────────────────── free-sleep firmware (hass-free-sleep)
_FS = re.compile(r"^(?P<dev>.+?)_(?P<side>left|right)_(?P<key>temperature|bed_presence|heart_rate|hrv|"
                 r"respiration_rate|away_mode)$")


def detect_freesleep(registry):
    u = _by_uid(registry, "free_sleep")
    if not u:
        return None
    sides = {"left": {}, "right": {}}
    shared = {}
    keymap = {"temperature": "climate", "bed_presence": "presence", "heart_rate": "heart_rate",
              "hrv": "hrv", "respiration_rate": "breath_rate", "away_mode": "away_switch"}
    for uid, e in u.items():
        m = _FS.match(uid)
        if m:
            dom = e["entity_id"].split(".")[0]
            k = keymap[m.group("key")]
            if k == "climate" and dom != "climate":
                continue
            sides[m.group("side")][k] = e["entity_id"]
            continue
        for suf, key in (("_water_level", "water_low"), ("_priming", "priming"), ("_prime", "prime_button"),
                         ("_biometrics", "biometrics_toggle")):
            if uid.endswith(suf) and not uid.endswith("_prime_daily"):
                shared[key] = e["entity_id"]
    notes = []
    if shared.get("biometrics_toggle"):
        notes.append("Turn on free-sleep's Biometrics switch — presence and vitals depend on it.")
    return _hit("freesleep", "free-sleep", sides, shared, notes, ssh=True)


# ─────────────────────────────────────────────── Eight Sleep cloud (eight_sleep custom integration)
def detect_cloud(registry, states=None):
    # a list, not a dict: this integration reuses one unique_id across sensor + binary_sensor
    ents = [e for e in registry if e.get("platform") == "eight_sleep" and e.get("unique_id")
            and not e.get("disabled_by")]
    if not ents:
        return None
    users = []
    for e in ents:
        uid = e["unique_id"]
        if e["entity_id"].startswith("climate.") and uid.endswith(".climate"):
            parts = uid.split(".")
            if len(parts) >= 2:
                users.append((parts[-2], e["entity_id"]))
    if not users:
        return None
    suffix = {"current_heart_rate": "heart_rate", "current_hrv": "hrv", "current_breath_rate": "breath_rate",
              "bed_temperature": "bed_temp", "side": "side_sensor", "bed_state": "bed_state",
              "bed_presence": "presence", "next_alarm": "next_alarm"}
    per = {}
    for user, climate in users:
        d = {"climate": climate}
        for e in ents:
            uid = e["unique_id"]
            if user not in uid:
                continue
            # "<account>.<user>.<key>" (sensors) or "<user>_<key>" (newer binary sensors)
            last = uid.split(".")[-1] if "." in uid else uid.split(user + "_", 1)[-1]
            dom = e["entity_id"].split(".")[0]
            for suf, key in suffix.items():
                if last != suf:
                    continue
                if (key == "presence") != (dom == "binary_sensor"):
                    continue
                if key != "presence" and dom != "sensor":
                    continue
                d.setdefault(key, e["entity_id"])
        per[user] = d
    # left/right from the side sensor where it says so; otherwise first = left
    sides, spare = {}, []
    for user, d in per.items():
        st = ((states or {}).get(d.get("side_sensor")) or {}).get("state", "")
        if st in ("left", "right") and st not in sides:
            sides[st] = d
        else:
            spare.append(d)
    for d in spare:
        for s in ("left", "right"):
            if s not in sides:
                sides[s] = d
                break
    shared = {}
    for e in ents:
        uid = e["unique_id"]
        for suf, key in ((".has_water", "has_water"), (".is_priming", "is_priming")):
            if uid.endswith(suf) and e["entity_id"].startswith("sensor."):
                shared[key] = e["entity_id"]
    notes = ["Cloud control goes through Eight Sleep's servers — expect a few seconds of lag, and "
             "nothing works if their API is down."]
    if not any(s.get("presence") for s in sides.values()):
        notes.append("Your eight_sleep integration version has no bed-presence binary sensor — "
                     "pick one by hand below.")
    return _hit("cloud", "Eight Sleep cloud", sides, shared, notes)


def _mark_online(hit, states):
    """A registry entry isn't a working Pod: the integration may be gone and its entities stale."""
    if not hit or states is None:
        return hit
    live = [s for s in hit["sides"].values()
            if (states.get(s["climate"]) or {}).get("state") not in (None, "unavailable", "unknown")]
    hit["online"] = bool(live)
    if not live:
        hit["notes"].insert(0, "Its entities exist but are unavailable — this integration looks "
                               "removed or offline.")
    return hit


def detect_all(registry, states=None):
    return {"gateway": _mark_online(detect_gateway(registry), states),
            "freesleep": _mark_online(detect_freesleep(registry), states),
            "cloud": _mark_online(detect_cloud(registry, states), states)}


# ─────────────────────────────────────────────── pickers for the rest of the wizard
def pickers(states, services=None):
    """Candidate entities for the room / notify / scene questions, best guess first."""
    def by(pred):
        return sorted(e for e, s in states.items() if pred(e, s.get("attributes") or {}))

    def room_first(lst):
        return sorted(lst, key=lambda e: (0 if "bed" in e else 1 if "room" in e else 2, e))

    weather = by(lambda e, a: e.startswith("weather."))
    def mine(e):  # the bed's own sensors aren't the room
        return any(k in e for k in ("eight_sleep", "eight_plus", "pod_3_"))
    temps = room_first(by(lambda e, a: e.startswith("sensor.") and a.get("device_class") == "temperature"
                          and not mine(e)))
    hums = room_first(by(lambda e, a: e.startswith("sensor.") and a.get("device_class") == "humidity"
                         and not mine(e)))
    pm25 = by(lambda e, a: e.startswith("sensor.") and a.get("device_class") == "pm25")
    scenes = by(lambda e, a: e.startswith(("scene.", "script.")) and not e.startswith("script.eight_sleep"))
    notify = sorted(f"notify.{k}" for k in ((services or {}).get("notify") or {})
                    if k.startswith("mobile_app_"))
    used = set(weather + temps + hums + pm25 + scenes)
    names = {e: (states[e].get("attributes") or {}).get("friendly_name") or e for e in used}
    return {"weather": weather, "temperature": temps, "humidity": hums, "pm25": pm25,
            "scenes": scenes, "notify": notify, "names": names}
