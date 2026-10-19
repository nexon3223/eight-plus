#!/usr/bin/env python3
"""
es-led -- customise the Eight Sleep Pod 3 front status LED from Home Assistant.

The front LED is a Lumissil IS31FL3194 3-channel RGB driver on /dev/i2c-1 @ 0x53.
Stock `Eight.Capybara` drives it from connectivity state (green/blue), but only
writes the chip on a state change -- in steady state it never touches the bus, so
a slow re-assert loop here wins without masking or fighting anything.

Verified on the hardware (2026-09-10):
  * ONLY RGB pattern mode responds (single / current-level mode does nothing).
  * Channel -> colour: OUT1 = BLUE (reg 0x10), OUT2 = RED (0x11), OUT3 = GREEN (0x12).

Exposes one MQTT-discovery light `light.eight_sleep_pod_led` on the existing
"Eight Sleep Pod" device:  rgb colour + brightness + effect
(Solid / Breathe / Pulse / Rainbow / Candle / Strobe).  Effect "Auto" releases
the LED back to Capybara's connectivity indicator.

State persists across restarts in /opt/es-led/state.json.
"""
import fcntl
import json
import math
import os
import signal
import struct
import threading
import time

import paho.mqtt.client as mqtt

# ---------------------------------------------------------------- config
I2C_BUS = "/dev/i2c-1"
I2C_ADDR = 0x53
I2C_SLAVE = 0x0703

REASSERT_S = 2.0          # how often we re-write the chip to beat Capybara
DYN_TICK_S = 0.08         # frame time for software effects (Rainbow/Candle/Strobe)
STATE_PATH = "/opt/es-led/state.json"

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
NODE = "eight_pod_led"
BASE = "eightpod/led"
STATE_T = f"{BASE}/state"
CMD_T = f"{BASE}/set"
AVAIL_T = f"{BASE}/availability"

DEVICE = {
    "identifiers": ["eight_sleep_pod_local"],
    "name": "Eight Sleep Pod",
    "manufacturer": "Eight Sleep",
    "model": "Pod 3 (stock + local control)",
}

EFFECTS = ["Solid", "Breathe", "Pulse", "Rainbow", "Candle", "Strobe", "Auto"]

DEFAULT_STATE = {"state": "ON", "brightness": 160,
                 "color": {"r": 255, "g": 120, "b": 20}, "effect": "Solid"}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------------------------------------------------------------- IS31FL3194
class Led:
    """Minimal IS31FL3194 driver -- RGB pattern mode only (the mode that works)."""

    def __init__(self):
        self.fd = os.open(I2C_BUS, os.O_RDWR)
        fcntl.ioctl(self.fd, I2C_SLAVE, I2C_ADDR)
        self._lock = threading.Lock()

    def _w(self, reg, val):
        os.write(self.fd, bytes((reg & 0xFF, val & 0xFF)))

    def reset(self):
        with self._lock:
            self._w(0x4F, 0xC5)
            time.sleep(0.003)

    def release(self):
        """Software-shutdown -- hand the chip back to Capybara."""
        with self._lock:
            self._w(0x4F, 0xC5)
            time.sleep(0.003)
            self._w(0x01, 0x00)

    def _prep(self):
        self._w(0x01, 0x7D)   # SSD on, RGB mode, all three OUTx in pattern mode
        self._w(0x02, 0x07)   # enable OUT1/OUT2/OUT3
        self._w(0x03, 0x3F)   # current band 4 (40 mA) on every channel

    @staticmethod
    def _chan(r, g, b, bright):
        """Scale + mild gamma; return (blue, red, green) = OUT1, OUT2, OUT3 bytes."""
        k = max(0.0, min(1.0, bright / 255.0))
        def c(x):
            v = max(0.0, min(1.0, (x / 255.0))) * k
            return int(round((v ** 1.8) * 255))
        return c(b), c(r), c(g)

    def solid(self, r, g, b, bright):
        o1, o2, o3 = self._chan(r, g, b, bright)
        with self._lock:
            self._prep()
            self._w(0x10, o1); self._w(0x11, o2); self._w(0x12, o3)   # P1 colour 1
            self._w(0x19, 0x10)   # T1 fast rise, TS 0
            self._w(0x1A, 0xF0)   # T2 long hold, T3 0
            self._w(0x1B, 0x00)   # TP / T4 0
            self._w(0x1C, 0x01)   # colour-1 enable
            self._w(0x1D, 0x00)   # colour cycle times
            self._w(0x1E, 0x00)   # NXT: just stop (we hold via HF below)
            self._w(0x1F, 0x00)   # loop endless
            self._w(0x04, 0x09)   # HF1 enable + HT1 hold at end of T2 -> colour stays lit
            self._w(0x40, 0xC5)   # latch colour data
            self._w(0x41, 0xC5)   # start pattern 1

    def breathe(self, r, g, b, bright, t_rise=0xA0, t_hold=0x20, t_fall=0xA0, t_off=0x20):
        """Hardware auto-breathing on one colour, looping forever."""
        o1, o2, o3 = self._chan(r, g, b, bright)
        with self._lock:
            self._prep()
            self._w(0x10, o1); self._w(0x11, o2); self._w(0x12, o3)
            self._w(0x19, (t_rise & 0xF0) | 0x00)          # D7:D4 T1, D3:D0 TS
            self._w(0x1A, ((t_fall >> 4) & 0x0F) << 4 | ((t_hold >> 4) & 0x0F))  # D7:D4 T3, D3:D0 T2
            self._w(0x1B, ((t_off >> 4) & 0x0F))            # D3:D0 T4, D7:D4 TP=0
            self._w(0x1C, 0x01)   # colour-1 enable
            self._w(0x1D, 0x00)
            self._w(0x1E, 0x00)   # gamma 2.4, MTPLT endless
            self._w(0x1F, 0x00)   # loop endless
            self._w(0x04, 0x00)   # no hold -- keep cycling
            self._w(0x40, 0xC5)
            self._w(0x41, 0xC5)

    def close(self):
        try:
            os.close(self.fd)
        except OSError:
            pass


# ---------------------------------------------------------------- effect engine
def hsv_to_rgb(h, s, v):
    i = int(h * 6.0)
    f = h * 6.0 - i
    p, q, t = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
    r, g, b = [(v, t, p), (q, v, p), (p, v, t),
               (p, q, v), (t, p, v), (v, p, q)][i % 6]
    return int(r * 255), int(g * 255), int(b * 255)


class Engine(threading.Thread):
    def __init__(self, led, get_state):
        super().__init__(daemon=True)
        self.led = led
        self.get_state = get_state
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._applied = None          # signature of what's on the chip
        self._phase = 0.0

    def notify(self):
        self._wake.set()

    def stop(self):
        self._stop.set()
        self._wake.set()

    def run(self):
        while not self._stop.is_set():
            st = self.get_state()
            eff = st.get("effect", "Solid")
            on = st.get("state") == "ON"
            col = st.get("color", {})
            r, g, b = col.get("r", 255), col.get("g", 255), col.get("b", 255)
            br = st.get("brightness", 160)
            sig = (on, eff, r, g, b, br)

            dynamic = on and eff in ("Rainbow", "Candle", "Strobe")

            if eff == "Auto":
                if self._applied != sig:
                    self.led.release()
                    self._applied = sig
                    log("effect Auto -> released to Capybara")
                self._wait(REASSERT_S)
                continue

            if not on:
                if self._applied != sig:
                    self.led.solid(0, 0, 0, 0)
                    self._applied = sig
                    log("state OFF")
                self._wait(REASSERT_S)
                continue

            if dynamic:
                self._phase += DYN_TICK_S
                if eff == "Rainbow":
                    h = (self._phase * 0.12) % 1.0
                    rr, gg, bb = hsv_to_rgb(h, 1.0, 1.0)
                    self.led.solid(rr, gg, bb, br)
                elif eff == "Candle":
                    flick = 0.75 + 0.25 * math.sin(self._phase * 7) * (0.5 + 0.5 * math.sin(self._phase * 2.3))
                    self.led.solid(255, 110, 20, max(20, int(br * flick)))
                elif eff == "Strobe":
                    self.led.solid(r, g, b, br if int(self._phase * 8) % 2 else 0)
                self._applied = ("dyn", eff)
                self._wait(DYN_TICK_S)
                continue

            # static hardware effects -- (re-)assert on change, then keep beating Capybara
            if self._applied != sig:
                if eff == "Breathe":
                    self.led.breathe(r, g, b, br)
                elif eff == "Pulse":
                    self.led.breathe(r, g, b, br, 0x40, 0x10, 0x40, 0x10)
                else:  # Solid
                    self.led.solid(r, g, b, br)
                self._applied = sig
                log(f"effect {eff} rgb({r},{g},{b}) bri {br}")
            else:
                # cheap periodic re-assert (Capybara only writes on connectivity change)
                if eff in ("Breathe", "Pulse"):
                    self.led.breathe(r, g, b, br) if eff == "Breathe" else \
                        self.led.breathe(r, g, b, br, 0x40, 0x10, 0x40, 0x10)
                else:
                    self.led.solid(r, g, b, br)
            self._wait(REASSERT_S)

    def _wait(self, s):
        self._wake.wait(s)
        self._wake.clear()


# ---------------------------------------------------------------- state
_state = dict(DEFAULT_STATE)
_state_lock = threading.Lock()


def load_state():
    global _state
    try:
        with open(STATE_PATH) as f:
            d = json.load(f)
        merged = dict(DEFAULT_STATE)
        merged.update({k: d[k] for k in DEFAULT_STATE if k in d})
        _state = merged
        log("loaded state", _state)
    except (OSError, ValueError):
        log("no saved state, using default")


def save_state():
    try:
        os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
        tmp = STATE_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(_state, f)
        os.replace(tmp, STATE_PATH)
    except OSError as e:
        log("save_state failed:", e)


def get_state():
    with _state_lock:
        return dict(_state)


# ---------------------------------------------------------------- mqtt
_cli = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="es-led")
if MQTT_USER:
    _cli.username_pw_set(MQTT_USER, MQTT_PASS)
_cli.will_set(AVAIL_T, "offline", retain=True)
engine = None


def _discovery():
    cfg = {
        "schema": "json",
        "unique_id": NODE, "object_id": NODE,
        "name": "Front LED",
        "device": DEVICE,
        "availability_topic": AVAIL_T,
        "state_topic": STATE_T,
        "command_topic": CMD_T,
        "brightness": True,
        "brightness_scale": 255,
        "supported_color_modes": ["rgb"],
        "effect": True,
        "effect_list": EFFECTS,
        "icon": "mdi:led-on",
    }
    return f"{DISC}/light/{NODE}/config", json.dumps(cfg)


def publish_state():
    with _state_lock:
        s = dict(_state)
    payload = {
        "state": s["state"],
        "brightness": int(s["brightness"]),
        "color_mode": "rgb",
        "color": {"r": s["color"]["r"], "g": s["color"]["g"], "b": s["color"]["b"]},
        "effect": s["effect"],
    }
    _cli.publish(STATE_T, json.dumps(payload), retain=True)


def _on_connect(c, u, f, rc, props=None):
    if rc == 0:
        log("mqtt connected")
        t, p = _discovery()
        c.publish(t, p, retain=True)
        c.publish(AVAIL_T, "online", retain=True)
        c.subscribe(CMD_T)
        publish_state()


def _on_message(c, u, msg):
    try:
        cmd = json.loads(msg.payload.decode("utf-8"))
    except ValueError:
        return
    with _state_lock:
        if "state" in cmd:
            _state["state"] = "ON" if str(cmd["state"]).upper() == "ON" else "OFF"
        if "brightness" in cmd:
            _state["brightness"] = max(1, min(255, int(cmd["brightness"])))
        if "color" in cmd and isinstance(cmd["color"], dict):
            for k in ("r", "g", "b"):
                if k in cmd["color"]:
                    _state["color"][k] = max(0, min(255, int(cmd["color"][k])))
        if "effect" in cmd and cmd["effect"] in EFFECTS:
            _state["effect"] = cmd["effect"]
        # any colour/brightness command implies the light is on
        if ("color" in cmd or "brightness" in cmd) and "state" not in cmd:
            _state["state"] = "ON"
    save_state()
    publish_state()
    if engine:
        engine.notify()
    log("cmd", cmd)


_cli.on_connect = _on_connect
_cli.on_message = _on_message


# ---------------------------------------------------------------- main
def main():
    global engine
    load_state()
    led = Led()
    led.reset()
    engine = Engine(led, get_state)
    engine.start()

    stop = threading.Event()

    def _sig(*_):
        stop.set()
    signal.signal(signal.SIGTERM, _sig)
    signal.signal(signal.SIGINT, _sig)

    _cli.connect_async(MQTT_HOST, MQTT_PORT, keepalive=60)
    _cli.loop_start()
    try:
        while not stop.wait(1):
            pass
    finally:
        log("shutting down")
        engine.stop()
        try:
            _cli.publish(AVAIL_T, "offline", retain=True)
        except Exception:
            pass
        _cli.loop_stop()
        # leave the LED as last set (persisted); do NOT release on a mere restart
        led.close()


if __name__ == "__main__":
    main()
