#!/usr/bin/env python3
"""
es-biometrics-mqtt -- read-only tap publisher.

Runs ON the Pod. Reads:
  * /persistent/free-sleep-data/free-sleep.db   (vitals, movement -- written by es-biometrics)
  * /persistent/free-sleep-data/presence.json   (live presence -- written by the patched processor)
  * the latest /persistent/*.RAW                (room temp/humidity, water temps -- CBOR)
and publishes Home Assistant MQTT discovery + one retained state blob.

Touches nothing in the Pod control path. Stock firmware, cloud, app all untouched.
"""
import io
import json
import os
import time
import glob
import sqlite3
import datetime as dt

import cbor2
import paho.mqtt.client as mqtt

# ---------------------------------------------------------------- config
# MQTT broker — /etc/eight-plus/gateway.conf (KEY=value lines, written by gateway/install.sh),
# overridable by MQTT_* environment variables.
def _gateway_conf(path="/etc/eight-plus/gateway.conf"):
    c = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    c[k.strip()] = v.strip().strip('"')
    except OSError:
        pass
    c.update({k: v for k, v in os.environ.items() if k.startswith("MQTT_")})
    return c


_GW = _gateway_conf()
MQTT_HOST = _GW.get("MQTT_HOST", "homeassistant.local")
MQTT_PORT = int(_GW.get("MQTT_PORT", "1883"))
MQTT_USER = _GW.get("MQTT_USER", "")
MQTT_PASS = _GW.get("MQTT_PASS", "")
DISCOVERY_PREFIX = "homeassistant"
NODE = "eight_pod_bio"
BASE = "eightpod/bio"
STATE_TOPIC = f"{BASE}/state"
AVAIL_TOPIC = f"{BASE}/availability"

DB = "/persistent/free-sleep-data/free-sleep.db"
PRESENCE = "/persistent/free-sleep-data/presence.json"
RAW_DIR = "/persistent"

PUBLISH_INTERVAL = 15          # s
VITALS_STALE_AFTER = 180       # s -> heart_rate etc go unknown

SIDES = ("left", "right")

DEVICE = {
    "identifiers": ["eight_sleep_pod_local"],
    "name": "Eight Sleep Pod",
    "manufacturer": "Eight Sleep",
    "model": "Pod 3 (stock + biometrics tap)",
}

STATE = {}


def log(*a):
    print(dt.datetime.now().isoformat(timespec="seconds"), *a, flush=True)


# ---------------------------------------------------------------- readers
def read_vitals():
    """latest vitals row per side, plus age."""
    if not os.path.isfile(DB):
        return
    try:
        con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=3)
        con.row_factory = sqlite3.Row
        now = int(time.time())
        for s in SIDES:
            r = con.execute(
                "SELECT timestamp, heart_rate, hrv, breathing_rate FROM vitals "
                "WHERE side=? ORDER BY timestamp DESC LIMIT 1", (s,)).fetchone()
            if not r:
                continue
            age = now - int(r["timestamp"])
            STATE[f"{s}_vitals_age"] = age
            if age <= VITALS_STALE_AFTER:
                STATE[f"{s}_heart_rate"] = _num(r["heart_rate"])
                STATE[f"{s}_hrv"] = _num(r["hrv"])
                STATE[f"{s}_breathing_rate"] = _num(r["breathing_rate"])
            else:
                for k in ("heart_rate", "hrv", "breathing_rate"):
                    STATE[f"{s}_{k}"] = None
            # movement over the last 30 min
            since = now - 1800
            m = con.execute(
                "SELECT COALESCE(SUM(total_movement),0) FROM movement "
                "WHERE side=? AND timestamp>=?", (s, since)).fetchone()[0]
            STATE[f"{s}_movement_30m"] = round(float(m), 1)
        con.close()
    except Exception as e:
        log("vitals read error:", e)


def read_presence():
    STATE.setdefault("left_present", "OFF")
    STATE.setdefault("right_present", "OFF")
    if not os.path.isfile(PRESENCE):
        return
    try:
        d = json.load(open(PRESENCE))
        now = int(time.time())
        for s in SIDES:
            v = d.get(s) or {}
            fresh = (now - int(v.get("updated", 0))) < 600
            STATE[f"{s}_present"] = "ON" if (fresh and v.get("present")) else "OFF"
            STATE[f"{s}_present_for_min"] = round(int(v.get("present_for", 0)) / 60, 1)
    except Exception as e:
        log("presence read error:", e)


def read_raw_temps():
    """scan the tail of the newest .RAW for the most recent bedTemp / frzTemp."""
    files = [f for f in glob.glob(f"{RAW_DIR}/*.RAW") if not f.endswith("SEQNO.RAW")]
    if not files:
        return
    path = max(files, key=os.path.getmtime)
    try:
        # the .RAW is a clean sequence of CBOR objects from offset 0; it's only
        # a few MB, decode it straight through and keep the last temp records.
        with open(path, "rb") as f:
            buf = io.BytesIO(f.read())
        bed = frz = None
        while True:
            try:
                row = cbor2.load(buf)
            except Exception:
                break
            if not isinstance(row, dict) or not row.get("data"):
                continue
            try:
                d = cbor2.loads(row["data"])
            except Exception:
                continue
            if not isinstance(d, dict):
                continue
            if d.get("type") == "bedTemp":
                bed = d
            elif d.get("type") == "frzTemp":
                frz = d
        if bed:
            STATE["room_temperature"] = round(bed["amb"] / 100, 2)
            STATE["room_humidity"] = round(bed["hu"] / 100, 1)
            STATE["control_board_temp"] = round(bed["mcu"] / 100, 1)
        if frz:
            STATE["left_water_temp"] = round(frz["left"] / 100, 2)
            STATE["right_water_temp"] = round(frz["right"] / 100, 2)
            STATE["heatsink_temp"] = round(frz["hs"] / 100, 1)
        STATE["raw_stream"] = "ON" if (time.time() - os.path.getmtime(path)) < 120 else "OFF"
        STATE["raw_file"] = os.path.basename(path)
    except Exception as e:
        log("raw temps read error:", e)


def _num(v):
    try:
        v = float(v)
        return None if v != v else round(v, 1)   # drop NaN
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- discovery
def _cfg(comp, key, name, **extra):
    cfg = {
        "unique_id": f"{NODE}_{key}",
        "object_id": f"{NODE}_{key}",
        "availability_topic": AVAIL_TOPIC,
        "device": DEVICE,
        "name": name,
        "state_topic": STATE_TOPIC,
        "value_template": "{{ value_json.%s }}" % key,
    }
    cfg.update(extra)
    return f"{DISCOVERY_PREFIX}/{comp}/{NODE}/{key}/config", json.dumps(cfg)


def discovery_msgs():
    m = []
    for s in SIDES:
        S = s.capitalize()
        m.append(_cfg("sensor", f"{s}_heart_rate", f"{S} heart rate",
                      unit_of_measurement="bpm", icon="mdi:heart-pulse", state_class="measurement"))
        m.append(_cfg("sensor", f"{s}_hrv", f"{S} HRV",
                      unit_of_measurement="ms", icon="mdi:heart-flash", state_class="measurement"))
        m.append(_cfg("sensor", f"{s}_breathing_rate", f"{S} breathing rate",
                      unit_of_measurement="br/min", icon="mdi:lungs", state_class="measurement"))
        m.append(_cfg("binary_sensor", f"{s}_present", f"{S} presence", device_class="occupancy"))
        m.append(_cfg("sensor", f"{s}_present_for_min", f"{S} present for",
                      unit_of_measurement="min", icon="mdi:bed-clock"))
        m.append(_cfg("sensor", f"{s}_movement_30m", f"{S} movement (30m)", icon="mdi:sleep"))
        m.append(_cfg("sensor", f"{s}_vitals_age", f"{S} vitals age",
                      unit_of_measurement="s", icon="mdi:timer-sand", entity_category="diagnostic"))
        m.append(_cfg("sensor", f"{s}_water_temp", f"{S} water temp",
                      unit_of_measurement="°C", device_class="temperature", state_class="measurement"))
    m.append(_cfg("sensor", "room_temperature", "Room temperature",
                  unit_of_measurement="°C", device_class="temperature", state_class="measurement"))
    m.append(_cfg("sensor", "room_humidity", "Room humidity",
                  unit_of_measurement="%", device_class="humidity", state_class="measurement"))
    m.append(_cfg("sensor", "heatsink_temp", "Heatsink temperature",
                  unit_of_measurement="°C", device_class="temperature", entity_category="diagnostic"))
    m.append(_cfg("sensor", "control_board_temp", "Control board temperature",
                  unit_of_measurement="°C", device_class="temperature", entity_category="diagnostic"))
    m.append(_cfg("binary_sensor", "raw_stream", "Sensor stream",
                  device_class="running", entity_category="diagnostic"))
    m.append(_cfg("sensor", "raw_file", "RAW file", icon="mdi:file", entity_category="diagnostic"))
    return m


# ---------------------------------------------------------------- mqtt
client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="es-bio-mqtt")
if MQTT_USER:
    client.username_pw_set(MQTT_USER, MQTT_PASS)
client.will_set(AVAIL_TOPIC, "offline", retain=True)
_connected = False


def on_connect(c, u, flags, rc, props=None):
    global _connected
    if rc == 0:
        _connected = True
        log("mqtt connected")
        for topic, payload in discovery_msgs():
            c.publish(topic, payload, retain=True)
        c.publish(AVAIL_TOPIC, "online", retain=True)
    else:
        log("mqtt connect failed rc=", rc)


def on_disconnect(c, u, *a):
    global _connected
    _connected = False
    log("mqtt disconnected")


client.on_connect = on_connect
client.on_disconnect = on_disconnect


def main():
    client.connect_async(MQTT_HOST, MQTT_PORT, keepalive=60)
    client.loop_start()
    while True:
        try:
            read_vitals()
            read_presence()
            read_raw_temps()
            if _connected:
                client.publish(STATE_TOPIC, json.dumps(STATE), retain=True)
        except Exception as e:  # noqa: BLE001 - keep the publisher alive
            log("loop error:", e)
        time.sleep(PUBLISH_INTERVAL)


if __name__ == "__main__":
    main()
