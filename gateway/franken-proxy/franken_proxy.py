#!/usr/bin/env python3
"""
es-franken-proxy -- transparent frankenfirmware <-> dac splice with local command injection.

Stock layout:  dac  binds /deviceinfo/dac.sock  (server)
               frankenfirmware  connects to it  (client, one connection, never retries)
               traffic is strictly request/response, newline-framed, sep = b"\\n\\n":
                 dac -> frank : "14\\n\\n"                 (PLEASE_SEND_VARIABLES, ~1/s)
                 frank -> dac : "<name = value>\\n...\\n\\n"
                 dac -> frank : "<cmd>\\n<arg>\\n\\n"       (on a cloud command)

This proxy inserts itself in the middle:
               frank  connects to  /run/es-franken.sock  (we changed frank.sh's DAC_SOCKET)
               we connect to       /deviceinfo/dac.sock   (the real dac)
It relays every dac-initiated exchange verbatim, and BETWEEN those exchanges
injects locally-queued commands (HEAT_LEFT/RIGHT, LEVEL_LEFT/RIGHT), consuming
frank's reply itself so dac never sees an interleaved response.

It also parses the variable dumps and exposes an MQTT `climate` per side + on/off
to Home Assistant.  dac keeps doing cloud + heartbeat + telemetry untouched, so
warranty / app / capybara stay happy.

If frank never (re)connects within FRANK_KICK_AFTER seconds of us starting,
we `systemctl restart frank` once -- frank only dials the socket at startup.

Also listens on a local-only Unix socket (LOCAL_CTL_SOCK) for the on-Pod
web UI (see gateway/webui/) so temp/power control and status work even with
no network / MQTT broker / Home Assistant reachable -- it shares this same
process's command queue and state, it doesn't open a second path into frank.
"""
import collections
import json
import os
import selectors
import socket
import subprocess
import threading
import time

import paho.mqtt.client as mqtt

# ---------------------------------------------------------------- config
LISTEN_SOCK = "/run/es-franken.sock"
LOCAL_CTL_SOCK = "/run/es-franken-ctl.sock"
DAC_SOCK = "/deviceinfo/dac.sock"
SEP = b"\n\n"
FRANK_KICK_AFTER = 60          # s: no frank connection -> restart frank
FRANK_KICK_COOLDOWN = 300      # s: never kick frank more often than this
INTENT_FILE = "/persistent/es-franken-proxy/intent.json"   # survives reboots
INTENT_MAX_AGE = 12 * 3600     # s: older than this and we don't restore it

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
DISC = "homeassistant"
NODE = "eight_pod_ctl"
BASE = "eightpod/ctl"
STATE_T = f"{BASE}/state"
AVAIL_T = f"{BASE}/availability"
CMD_T = f"{BASE}/cmd"         # eightpod/ctl/cmd/<key>

# frankenCommands (from dac's utils.ts)
HEAT = {"left": b"9", "right": b"10"}
LEVEL = {"left": b"11", "right": b"12"}
PRIME = b"13"
GET_VARS = b"14"
ALARM = {"left": b"5", "right": b"6"}   # frank: sparkAlarmL/R -> Sensor MCU vibration motors
ON_SECONDS = 43200            # 12h; refreshed while "on"

# level <-> celsius : frank logs "set target temp (L: 0, 27.00C)" / "(R: 100, 45.00C)"
#   celsius = 27.00 + level * 0.18   (linear, level clamped -100..100)
C0, SLOPE = 27.0, 0.18
TMIN, TMAX = round(C0 + -100 * SLOPE, 1), round(C0 + 100 * SLOPE, 1)   # 9.0 .. 45.0


def c_to_level(c):
    return max(-100, min(100, round((float(c) - C0) / SLOPE)))


def level_to_c(lvl):
    try:
        return round(C0 + int(lvl) * SLOPE, 2)
    except (TypeError, ValueError):
        return None


DEVICE = {
    "identifiers": ["eight_sleep_pod_local"],
    "name": "Eight Sleep Pod",
    "manufacturer": "Eight Sleep",
    "model": "Pod 3 (stock + local control)",
}

STATE = {}
_pending = collections.deque()      # queued franken commands: list[bytes] frames w/o SEP
_pending_lock = threading.Lock()
_want_on = {"left": None, "right": None}   # None=unknown, True/False track desired power

# --- local-authoritative: undo dac's idle "park to level 0" -------------------
# dac (stock) runs a local failsafe that periodically re-sends leftLevel/rightLevel 0
# + leftHeat/rightHeat 0 to the firmware whenever it sees no active session -> bed
# drops to level 0 (= 27.00 C) and off, fighting HA. We don't drop or rewrite dac's
# frames (that broke the req/resp handshake); we let them through, then immediately
# re-queue our own held setpoint so frank flips back within ~1s. dac stays happy.
_local_level = {"left": None, "right": None}   # last HA/card-commanded level (int)
_CMD_SIDE = {b"9": ("left", "heat"), b"10": ("right", "heat"),
             b"11": ("left", "level"), b"12": ("right", "level")}


# --- vibration alarms (2026-09-26) ------------------------------------------------
# frank takes ALARM_LEFT/RIGHT with a hex CBOR map {pl: power 0-100, du: seconds,
# tt: unix trigger time, pi: "double"|"rise"} and hands it to the Sensor MCU
# (log: "[alarm] vib. left: time T, power P, pattern X, dur D"). dac re-sends
# {pl:0, tt:0} ("no alarm") every ~7 min, so while one of ours is live we counter
# it exactly like the level park above.
ALARM_PATTERNS = ("double", "rise")
_alarm = {"left": None, "right": None}      # {"pl","du","tt","pi"} while armed/ringing


def _cbor_uint(major, n):
    if n < 24:
        return bytes([major << 5 | n])
    for code, size in ((24, 1), (25, 2), (26, 4)):
        if n < 1 << (8 * size):
            return bytes([major << 5 | code]) + n.to_bytes(size, "big")
    raise ValueError("too big")


def _alarm_payload(a):
    out = _cbor_uint(5, 4)
    for k in ("pl", "du", "tt", "pi"):
        v = a[k]
        out += _cbor_uint(3, len(k)) + k.encode()
        out += _cbor_uint(3, len(v)) + v.encode() if isinstance(v, str) else _cbor_uint(0, int(v))
    return out.hex().encode()


def _alarm_live(side):
    a = _alarm[side]
    if a and time.time() > a["tt"] + a["du"] + 5:
        _alarm[side] = a = None
    return a


def apply_alarm(side: str, power=None, duration=30, pattern="double", at=None) -> dict:
    """Vibrate `side`. power 0 (or None) = cancel. at = unix time (default: now)."""
    if not power:
        _alarm[side] = None
        a = {"pl": 0, "du": 600, "tt": 0, "pi": "double"}
    else:
        pi = pattern if pattern in ALARM_PATTERNS else "double"
        a = {"pl": max(1, min(100, int(power))), "du": max(1, min(600, int(duration))),
             "tt": int(at) if at else int(time.time()) + 2, "pi": pi}
        _alarm[side] = a
    _queue(ALARM[side] + b"\n" + _alarm_payload(a))
    log(f"alarm {side} -> {a}")
    return a


def _counter_park(req: bytes):
    """After a dac per-side heat/level command, re-assert our held intent for
    that side. No-op if HA/card has never set anything for it."""
    parts = req.split(b"\n")
    if len(parts) >= 2 and parts[0] in (ALARM["left"], ALARM["right"]):
        side = "left" if parts[0] == ALARM["left"] else "right"
        a = _alarm_live(side)
        if a and parts[1] != _alarm_payload(a):
            _queue(ALARM[side] + b"\n" + _alarm_payload(a))
            log(f"counter dac alarm-off {side} -> re-arm")
        return
    if len(parts) < 2 or parts[0] not in _CMD_SIDE:
        return
    side, kind = _CMD_SIDE[parts[0]]
    if kind == "level" and _local_level[side] is not None \
            and parts[1] != str(_local_level[side]).encode():
        _queue(LEVEL[side] + b"\n" + str(_local_level[side]).encode())
        log(f"counter dac level {side} {parts[1].decode()!r} -> {_local_level[side]}")
    if kind == "heat" and _want_on.get(side) and parts[1] in (b"0", b""):
        _queue(HEAT[side] + b"\n" + str(ON_SECONDS).encode())
        log(f"counter dac heat-off {side} -> on")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------------------------------------------------------------- framed socket
class Framed:
    def __init__(self, sock):
        self.s = sock
        self.buf = b""

    def feed(self):
        d = self.s.recv(65536)
        if not d:
            raise ConnectionError("peer closed")
        self.buf += d

    def take(self):
        i = self.buf.find(SEP)
        if i < 0:
            return None
        m, self.buf = self.buf[:i], self.buf[i + len(SEP):]
        return m

    def read_message(self, timeout=None, none_on_timeout=True):
        """Return the next framed message. With none_on_timeout=True a timeout
        yields None (idle poll); with False it raises (a hung/dead peer)."""
        self.s.setblocking(True)
        self.s.settimeout(timeout)
        try:
            while True:
                m = self.take()
                if m is not None:
                    return m
                self.feed()
        except (socket.timeout, BlockingIOError):
            if none_on_timeout:
                return None
            raise ConnectionError("peer timed out")
        finally:
            self.s.settimeout(None)

    def send_frame(self, frame):
        self.s.sendall(frame + SEP)


# ---------------------------------------------------------------- var parsing
_last_vars = 0.0          # time.time() of the last GET_VARS reply from frank
_last_cmd = 0.0           # time.time() of the last command we injected into frank


def parse_vars(resp: bytes):
    global _last_vars
    _last_vars = time.time()
    changed = False
    for line in resp.decode("utf-8", "replace").split("\n"):
        if " = " not in line:
            continue
        k, v = line.split(" = ", 1)
        k, v = k.strip(), v.strip().strip('"')
        if k in ("heatLevelL", "heatLevelR", "tgHeatLevelL", "tgHeatLevelR",
                 "heatTimeL", "heatTimeR", "waterLevel", "priming"):
            STATE[k] = v
            changed = True
    if changed:
        for s, L in (("left", "L"), ("right", "R")):
            tg = level_to_c(STATE.get(f"tgHeatLevel{L}"))
            if tg is not None:                       # never publish a null target
                STATE[f"{s}_target_c"] = tg          # (HA echoes current->set_temp on a null)
            elif f"{s}_target_c" not in STATE:
                STATE[f"{s}_target_c"] = C0
            cur = level_to_c(STATE.get(f"heatLevel{L}"))
            if cur is not None:
                STATE[f"{s}_current_c"] = cur
            t = STATE.get(f"heatTime{L}")
            on = _want_on[s]
            if on is None:
                on = bool(t and t.isdigit() and int(t) > 5)
            STATE[f"{s}_mode"] = "heat_cool" if on else "off"
        STATE["water_low"] = "ON" if str(STATE.get("waterLevel", "1")).lower() in ("0", "false") else "OFF"
        STATE["priming"] = "ON" if str(STATE.get("priming", "0")) not in ("0", "false", "") else "OFF"
        _publish_state()


# ---------------------------------------------------------------- mqtt
_cli = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="es-franken-proxy")
if MQTT_USER:
    _cli.username_pw_set(MQTT_USER, MQTT_PASS)
_cli.will_set(AVAIL_T, "offline", retain=True)
_connected = False


def _disc():
    msgs = []
    for s in ("left", "right"):
        S = s.capitalize()
        cfg = {
            "unique_id": f"{NODE}_{s}", "object_id": f"{NODE}_{s}",
            "name": S, "device": DEVICE, "availability_topic": AVAIL_T,
            "icon": "mdi:bed",
            "modes": ["off", "heat_cool"],
            "mode_state_topic": STATE_T, "mode_state_template": "{{ value_json.%s_mode }}" % s,
            "mode_command_topic": f"{CMD_T}/{s}_mode",
            "temperature_state_topic": STATE_T, "temperature_state_template": "{{ value_json.%s_target_c }}" % s,
            "temperature_command_topic": f"{CMD_T}/{s}_target",
            "current_temperature_topic": STATE_T, "current_temperature_template": "{{ value_json.%s_current_c }}" % s,
            "min_temp": TMIN, "max_temp": TMAX, "temp_step": 0.5, "precision": 0.1, "temperature_unit": "C",
            "optimistic": False,
        }
        msgs.append((f"{DISC}/climate/{NODE}/{s}/config", json.dumps(cfg)))
    for key, name, dc in (("water_low", "Water low", "problem"), ("priming", "Priming", "running")):
        cfg = {"unique_id": f"{NODE}_{key}", "object_id": f"{NODE}_{key}", "name": name,
               "device": DEVICE, "availability_topic": AVAIL_T, "device_class": dc,
               "state_topic": STATE_T, "value_template": "{{ value_json.%s }}" % key,
               "entity_category": "diagnostic"}
        msgs.append((f"{DISC}/binary_sensor/{NODE}/{key}/config", json.dumps(cfg)))
    prime_cfg = {"unique_id": f"{NODE}_prime", "object_id": f"{NODE}_prime", "name": "Prime",
                 "device": DEVICE, "availability_topic": AVAIL_T, "icon": "mdi:water-pump",
                 "command_topic": f"{CMD_T}/prime", "payload_press": "PRESS",
                 "entity_category": "config"}
    msgs.append((f"{DISC}/button/{NODE}/prime/config", json.dumps(prime_cfg)))
    for s in ("left", "right"):
        for key, name, icon in ((f"{s}_vibrate", f"{s.capitalize()} vibrate", "mdi:vibrate"),
                                (f"{s}_vibrate_stop", f"{s.capitalize()} vibrate stop", "mdi:vibrate-off")):
            msgs.append((f"{DISC}/button/{NODE}/{key}/config", json.dumps({
                "unique_id": f"{NODE}_{key}", "default_entity_id": f"button.eight_sleep_pod_{key}", "name": name,
                "device": DEVICE, "availability_topic": AVAIL_T, "icon": icon,
                "command_topic": f"{CMD_T}/{key}", "payload_press": "PRESS"})))
    return msgs


def _publish_state():
    if _connected:
        _cli.publish(STATE_T, json.dumps(STATE), retain=True)


def _on_connect(c, u, f, rc, p=None):
    global _connected
    if rc == 0:
        _connected = True
        log("mqtt connected")
        for t, pl in _disc():
            c.publish(t, pl, retain=True)
        c.publish(AVAIL_T, "online", retain=True)
        c.subscribe(f"{CMD_T}/+")
        _publish_state()


def _queue(frame: bytes):
    with _pending_lock:
        _pending.append(frame)


# ---------------------------------------------------------------- shared command handlers
# Single source of truth for "apply a setpoint/power change", called from both
# the MQTT command topics and the local-only control socket (pod_webui.py).
def _save_intent():
    """Remember what HA/the card last asked for, so a watchdog reboot (or any restart)
    comes back holding the same setpoint instead of dac's idle level 0 / off."""
    try:
        os.makedirs(os.path.dirname(INTENT_FILE), exist_ok=True)
        tmp = INTENT_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"ts": time.time(), "want_on": _want_on, "level": _local_level}, f)
        os.replace(tmp, INTENT_FILE)
    except OSError as e:
        log("intent save failed:", repr(e))


def _restore_intent():
    try:
        with open(INTENT_FILE) as f:
            d = json.load(f)
    except (OSError, ValueError):
        return
    if time.time() - d.get("ts", 0) > INTENT_MAX_AGE:
        log("intent too old -- not restoring")
        return
    for s in ("left", "right"):
        on, lvl = d.get("want_on", {}).get(s), d.get("level", {}).get(s)
        _want_on[s] = on
        if isinstance(lvl, int):
            _local_level[s] = lvl
            _queue(LEVEL[s] + b"\n" + str(lvl).encode())
        if on is True:
            _queue(HEAT[s] + b"\n" + str(ON_SECONDS).encode())
        elif on is False:
            _queue(HEAT[s] + b"\n0")
    log(f"restored intent on={_want_on} level={_local_level}")


def apply_target(side: str, celsius) -> float:
    """Set a side's target temperature (deg C, clamped to TMIN..TMAX). Returns the
    clamped value actually applied. Turns the side on if it wasn't off-latched."""
    lvl = c_to_level(celsius)
    _local_level[side] = lvl          # hold this against dac's park loop
    _queue(LEVEL[side] + b"\n" + str(lvl).encode())
    if _want_on.get(side) is not False:
        _want_on[side] = True
        _queue(HEAT[side] + b"\n" + str(ON_SECONDS).encode())
    _save_intent()
    return level_to_c(lvl)


def apply_power(side: str, want: bool) -> bool:
    """Turn a side on/off. Returns False if this was a no-op dedupe."""
    if _want_on.get(side) is want:     # dedupe: repeat commands are common
        return False
    _want_on[side] = want
    if not want:
        _local_level[side] = None      # released -> stop countering dac for this side
    _queue(HEAT[side] + (b"\n" + str(ON_SECONDS).encode() if want else b"\n0"))
    _save_intent()
    return True


def apply_prime():
    _queue(PRIME + b"\nempty")


def _on_msg(c, u, msg):
    key = msg.topic.rsplit("/", 1)[-1]
    val = msg.payload.decode("utf-8", "replace").strip()
    log(f"cmd {key} <- {val!r}")
    if key == "prime":
        apply_prime()
        return
    if key.endswith("_alarm") or key.endswith("_vibrate") or key.endswith("_vibrate_stop"):
        side = key.split("_", 1)[0]
        if side not in ("left", "right"):
            return
        if key.endswith("_vibrate_stop") or val.lower() in ("off", "stop", "0", ""):
            apply_alarm(side, 0)
        elif key.endswith("_vibrate"):                   # HA test button
            apply_alarm(side, 50, 10, "double")
        else:
            try:
                d = json.loads(val)
            except ValueError:
                d = {}
            apply_alarm(side, d.get("power", 60), d.get("duration", 30), d.get("pattern", "double"), d.get("at"))
        return
    if key.endswith("_target"):
        apply_target(key[:-7], val)
    elif key.endswith("_mode"):
        apply_power(key[:-5], val != "off")


_cli.on_connect = _on_connect
_cli.on_message = _on_msg


# ---------------------------------------------------------------- local control socket
# Line-delimited JSON request/response, one request per connection. No auth --
# this is an AF_UNIX socket, so it is only reachable from processes on the Pod
# itself; it's the only sanctioned second entry point into this proxy's queue.
def _snapshot():
    now = time.time()
    out = {"ok": True, "mqtt_connected": _connected, "frank_connected": frank_up.is_set(),
           "vars_age": round(now - _last_vars, 1) if _last_vars else None,
           "last_cmd_age": round(now - _last_cmd, 1) if _last_cmd else None,
           "pending": len(_pending),
           "alarm": {s: _alarm_live(s) for s in ("left", "right")}}
    for s in ("left", "right"):
        out[s] = {
            "target_c": STATE.get(f"{s}_target_c"),
            "current_c": STATE.get(f"{s}_current_c"),
            "on": STATE.get(f"{s}_mode") == "heat_cool",
        }
    out["water_low"] = STATE.get("water_low") == "ON"
    out["priming"] = STATE.get("priming") == "ON"
    out["tmin_c"], out["tmax_c"] = TMIN, TMAX
    return out


def _handle_ctl(req: dict) -> dict:
    cmd = req.get("cmd")
    try:
        if cmd == "status":
            return _snapshot()
        if cmd == "set_target":
            side = req["side"]
            if side not in ("left", "right"):
                return {"ok": False, "error": "bad side"}
            applied = apply_target(side, req["celsius"])
            return {"ok": True, "applied_c": applied}
        if cmd == "set_power":
            side = req["side"]
            if side not in ("left", "right"):
                return {"ok": False, "error": "bad side"}
            apply_power(side, bool(req["on"]))
            return {"ok": True}
        if cmd == "prime":
            apply_prime()
            return {"ok": True}
        if cmd == "alarm":
            side = req["side"]
            if side not in ("left", "right"):
                return {"ok": False, "error": "bad side"}
            return {"ok": True, "alarm": apply_alarm(side, req.get("power"), req.get("duration", 30),
                                                     req.get("pattern", "double"), req.get("at"))}
        return {"ok": False, "error": f"unknown cmd {cmd!r}"}
    except (KeyError, ValueError, TypeError) as e:
        return {"ok": False, "error": str(e)}


def _ctl_client(conn: socket.socket):
    with conn:
        conn.settimeout(5)
        buf = b""
        try:
            while b"\n" not in buf:
                d = conn.recv(4096)
                if not d:
                    return
                buf += d
            line, _, _ = buf.partition(b"\n")
            req = json.loads(line.decode("utf-8", "replace"))
            resp = _handle_ctl(req)
        except (socket.timeout, json.JSONDecodeError, OSError) as e:
            resp = {"ok": False, "error": str(e)}
        try:
            conn.sendall(json.dumps(resp).encode() + b"\n")
        except OSError:
            pass


def _local_ctl_server():
    try:
        os.unlink(LOCAL_CTL_SOCK)
    except FileNotFoundError:
        pass
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(LOCAL_CTL_SOCK)
    os.chmod(LOCAL_CTL_SOCK, 0o666)
    srv.listen(8)
    log(f"local control socket listening on {LOCAL_CTL_SOCK}")
    while True:
        try:
            conn, _ = srv.accept()
        except OSError as e:
            log("local ctl accept failed:", repr(e))
            time.sleep(1)
            continue
        threading.Thread(target=_ctl_client, args=(conn,), daemon=True).start()


# ---------------------------------------------------------------- watchdog
def _frank_watchdog(up_evt):
    """frank only dials our socket at startup, so any time the relay drops (frank
    crash, dac restart, a relay timeout) nothing reconnects on its own. Watch for
    the whole life of the process -- not just the first minute after we start
    (2026-09-25: the relay died at 07:32 AEST, this used to be one-shot, and the
    bed sat unreachable for 2h20m until a manual reboot)."""
    last_kick = 0.0
    while True:
        if up_evt.wait(5):
            time.sleep(5)
            continue
        down_since = time.monotonic()
        while not up_evt.is_set() and time.monotonic() - down_since < FRANK_KICK_AFTER:
            time.sleep(1)
        if up_evt.is_set():
            continue
        if time.monotonic() - last_kick < FRANK_KICK_COOLDOWN:
            continue
        last_kick = time.monotonic()
        log(f"frank not connected for {FRANK_KICK_AFTER}s -- restarting frank")
        subprocess.run(["systemctl", "restart", "frank"], check=False)


# ---------------------------------------------------------------- main relay
def serve_once(listener):
    global _last_cmd
    log("waiting for frankenfirmware...")
    fk_conn, _ = listener.accept()
    log("frankenfirmware connected")
    frank_up.set()
    dac = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    for _ in range(60):
        try:
            dac.connect(DAC_SOCK)
            break
        except OSError:
            time.sleep(1)
    else:
        raise ConnectionError("could not connect to real dac.sock")
    log("connected to real dac")

    fk, dc = Framed(fk_conn), Framed(dac)
    # keep a periodic refresh of the "on" duration so a side we turned on stays on
    last_refresh = 0.0
    try:
        while True:
            req = dc.read_message(timeout=0.25)      # dac's request (or None if idle)
            if req is not None:
                fk.send_frame(req)
                resp = fk.read_message(timeout=30, none_on_timeout=False)
                dc.send_frame(resp)
                if req == GET_VARS:
                    parse_vars(resp)
                else:
                    _counter_park(req)      # re-assert HA setpoint if dac parked a side
            # inject queued local commands while dac is idle
            with _pending_lock:
                batch = list(_pending)
                _pending.clear()
            for frame in batch:
                fk.send_frame(frame)
                fk.read_message(timeout=30, none_on_timeout=False)   # consume frank's reply
            if batch:
                _last_cmd = time.time()
            # refresh "on" sides every ~10 min so the heat duration doesn't lapse
            now = time.time()
            if now - last_refresh > 600:
                last_refresh = now
                for s in ("left", "right"):
                    if _want_on.get(s):
                        _queue(HEAT[s] + b"\n" + str(ON_SECONDS).encode())
    finally:
        for x in (fk_conn, dac):
            try:
                x.close()
            except OSError:
                pass


frank_up = threading.Event()


def main():
    try:
        os.unlink(LISTEN_SOCK)
    except FileNotFoundError:
        pass
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(LISTEN_SOCK)
    os.chmod(LISTEN_SOCK, 0o777)
    listener.listen(1)

    _restore_intent()
    threading.Thread(target=_frank_watchdog, args=(frank_up,), daemon=True).start()
    threading.Thread(target=_local_ctl_server, daemon=True).start()
    _cli.connect_async(MQTT_HOST, MQTT_PORT, keepalive=60)
    _cli.loop_start()

    while True:
        try:
            serve_once(listener)
        except Exception as e:  # noqa: BLE001 - always come back for the next frank connection
            log("relay ended:", repr(e))
            frank_up.clear()
            time.sleep(2)


if __name__ == "__main__":
    main()
