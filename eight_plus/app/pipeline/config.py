"""
Pipeline config for the Eight+ add-on.

Same names as ~/pod-sleep-pipeline/bin/config.py so analyze/store/presence/calibrate/raw run
unchanged; the add-on fills the runtime values (paths, SSH, MQTT, sleepers) via configure().
"""
import os

STORE_DB = os.environ.get("STORE_DB", "/data/sleep.db")

# ---- Pod SSH (optional high-fidelity source: the Pod's own free-sleep.db) ----
POD_SSH = ""
POD_DB = "/persistent/free-sleep-data/free-sleep.db"
POD_PRESENCE = "/persistent/free-sleep-data/presence.json"
POD_DB_NEEDS_SUDO = True

# ---- MQTT (filled from the Supervisor's mqtt service) ------------------------
MQTT = {"host": "", "port": 1883, "user": "", "password": "", "client_id": "eight-plus-pipeline",
        "avail_topic": "eightplus/sleep/availability"}
DISCOVERY_PREFIX = "homeassistant"
MQTT_NODE = "eight_plus_sleep"
DEVICE = {"identifiers": ["eight_plus_sleep"], "name": "Eight+ Sleep", "manufacturer": "Eight+",
          "model": "Sleep statistics pipeline"}

SIDES = ("left", "right")
SIDE_LABEL = {"left": "Left", "right": "Right"}
# side -> {"slug","p","name"} — set from the installed plan
SLEEPERS = {}

# ---- rollup tuning (identical to the standalone pipeline) --------------------
EPOCH = 60
GAP_MERGE_MIN = 15
MIN_BLOCK_MIN = 45
NIGHT_ANCHOR_HOUR = 12
SLEEP_TARGET_H = 8.0
BASELINE_NIGHTS = 7
PRESENCE_EDGE_SLACK_MIN = 30
HISTORY_NIGHTS = 30


def configure(**kw):
    g = globals()
    for k, v in kw.items():
        if k not in g:
            raise KeyError(k)
        g[k] = v
