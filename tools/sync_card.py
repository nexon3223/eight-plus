#!/usr/bin/env python3
"""
Pull the card + Pod app shell from the card's development repo into this distribution repo,
turning the author's own build into the PUBLIC build on the way.

    python3 tools/sync_card.py [--src ../eight-sleep-card]

Copies (never edits the source repo):
  eight-sleep-card.js                  -> ./eight-sleep-card.js                (HACS serves this)
                                       -> eight_plus/app/bundle/eight-sleep-card.js
  images/es-bed.png, es-pillows.png    -> eight_plus/app/bundle/assets/
  kiosk/public/{index.html,app.js,sw.js,manifest.webmanifest,icons/}
                                       -> eight_plus/app/bundle/app/        (patched, see below)

The development card's inline defaults are one real household's entities. The public build:
  • derives every helper from `schedule_prefix` / `partner_schedule_prefix` instead
    (the same names the Eight+ add-on generates), and every cloud side sensor from `entity`
  • blanks the household-specific room / light / focus entities (features hide without them)
  • defaults font_url to false (the app's font is proprietary and is never shipped)
  • points the gateway preset's sleep score at the matching side and its Solo/Dual helper at
    input_boolean.eight_plus_dual_mode
  • strips personal names from comments
and then REFUSES to write anything if a personal string is still present (see LEAKS).

Patches applied to the app shell so one build serves any household:
  • app.js reads its card config from window.__POD_CONFIG (served by the add-on as /config.js)
  • index.html loads /config.js first and drops the build-stamp placeholders
  • the proprietary font is NOT copied (font_url: false in every generated config)
"""
import argparse
import json
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUNDLE = os.path.join(ROOT, "eight_plus", "app", "bundle")

# The maintainer's own entity names live in a gitignored rules file so they never appear in this
# repository. Shape: tools/publish_rules.example.json.
RULES_PATH = os.path.join(ROOT, "tools", "publish_rules.local.json")
RULES = {}
LEAKS = None
# generic: a public file never carries a private-network address or a private-notes link
GENERIC_LEAKS = r"192\.168\.\d+\.\d+|\[\[proj-"

PUBLIC_HEADER = """/*
 * Eight+ card — an Eight Sleep Pod app for Home Assistant.
 * https://github.com/nexon3223/eight-plus  ·  MIT licence
 *
 *   type: custom:eight-sleep-card
 *   source: cloud               # cloud | freesleep | gateway — fills in every entity for that backend
 *   entity: climate.alex_s_eight_sleep_side_climate   # this side's climate entity
 *   schedule_prefix: eight_sleep_alex   # the helpers the Eight+ add-on created for this sleeper
 *   layout: v2
 *
 * Without the Eight+ add-on, any feature whose entities don't exist simply hides.
 * Every option is listed in setConfig() below; the add-on writes a complete config for you.
 *
 * Not affiliated with Eight Sleep. "Eight Sleep" and "Pod" are their trademarks.
 */
"""

# Expressions defined just above the defaults object in setConfig() (the public build only).
DERIVE = (
    "    // public build: helpers follow the sleeper prefix the Eight+ add-on generates; cloud side\n"
    "    // sensors follow the climate entity (climate.<x>_climate -> sensor.<x>_side, _next_alarm ...)\n"
    "    const __P = config.schedule_prefix || \"eight_sleep_me\";\n"
    "    const __PP = config.partner_schedule_prefix || \"\";\n"
    "    const __S = String(config.entity || preset.entity || \"\").replace(/^climate\\./, \"\").replace(/_climate$/, \"\");\n"
    "    const __CLOUD = source === \"cloud\";\n"
)

# Re-points a local preset at the configured entity (public build only).
PRESET_FOR = r"""// Public build: a preset is written for the left side of a "Pod 3". _presetFor() re-points it at
// the configured `entity` — the other half of the bed (left <-> right everywhere), and for
// free-sleep the entity-id stem hass-free-sleep derived from the Pod model + side name.
function _presetFor(source, entity) {
  const base = CONNECTORS[source] || {};
  if (!entity || source === "cloud") return base;
  let own = "left", stem = null, podStem = null;
  if (source === "freesleep") {
    const m = /^climate\.(.+)_temperature$/.exec(entity);
    if (m) {
      stem = m[1];
      const lr = /^(.+)_(left|right)$/.exec(stem);
      if (lr) { podStem = lr[1]; own = lr[2]; }
    }
  } else if (/_right$/.test(entity)) {
    own = "right";
  }
  const other = own === "left" ? "right" : "left";
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    let x = v;
    if (typeof x === "string") {
      x = x.replace(/_(left|right)(?=_|$)/g, (_, s) => "_" + (s === "left" ? own : other));
      if (source === "freesleep" && podStem) x = x.replace(/\bpod_3_/, podStem + "_");
    }
    out[k] = x;
  }
  // a renamed free-sleep side ("pod_4_alex"): own entities follow it, the partner can't be guessed
  if (source === "freesleep" && stem && !podStem) {
    for (const [k, v] of Object.entries(out)) {
      if (typeof v !== "string") continue;
      if (/^partner_/.test(k) && /pod_3_right_/.test(v)) out[k] = false;
      else out[k] = v.replace(/pod_3_left_/, stem + "_");
    }
  }
  out.entity = entity;
  return out;
}
"""

def _defaults_line(line):
    m = re.match(r'^(\s+[a-z0-9_]+: )"([^"]*)"(,.*)$', line)
    if not m:
        return line
    head, val, tail = m.groups()
    R = RULES
    if val in R["values"]:                          # one-off values (odd helper names)
        return head + R["values"][val] + tail
    if val in R["blank"]:                           # the household's own devices
        return head + '""' + tail
    if R["account_cloud_prefix"] in val:            # account-level cloud sensors: no derivable pattern
        return head + "false" + tail
    if R["partner_cloud_side"] + "_" in val:        # partner side's cloud entities: set in config
        return head + '""' + tail
    if R["author_cloud_side"] + "_" in val:
        v = val.replace(R["author_cloud_side"], "${__S}")
        return head + f"__CLOUD ? `{v}` : false" + tail
    if R["partner_prefix"] in val:
        v = val.replace(R["partner_prefix"], "${__PP}")
        return head + f"__PP ? `{v}` : \"\"" + tail
    if R["author_prefix"] in val:
        return head + "`" + val.replace(R["author_prefix"], "${__P}") + "`" + tail
    if head.strip() == "font_url:":
        return head + "false" + tail
    return line


def public_card(src):
    s = src
    # 1. header comment
    s = re.sub(r"\A/\*.*?\*/\n", PUBLIC_HEADER, s, count=1, flags=re.S)

    # 2. the defaults object in setConfig()
    start = s.index("    this._config = Object.assign(\n      {\n")
    end = s.index("      preset,\n      config\n    );", start)
    block = "\n".join(_defaults_line(l) for l in s[start:end].split("\n"))
    # partner_name/labels stay generic; ap_signals entries are inline objects
    block = re.sub(r'entity: "input_boolean\.' + re.escape(RULES["author_prefix"]) + r'_(ap_use_[a-z_]+)"',
                   r"entity: `input_boolean.${__P}_\1`", block)
    # cloud: the next-alarm sensor sits next to the side sensor (local presets set alarm_entity: false)
    block, n = re.subn(r"(\n(\s+)side_state_entity: __CLOUD \? `sensor\.\$\{__S\}_side` : false,\n)",
                       r"\1\2alarm_entity: __CLOUD ? `sensor.${__S}_next_alarm` : false,\n", block, count=1)
    if n != 1:
        sys.exit("public build: couldn't place the cloud alarm_entity default")
    s = s[:start] + DERIVE + block + s[end:]

    # 2b. local presets follow the configured entity: a right-side card swaps every left/right, and
    #     free-sleep's entity ids carry the Pod model + side name ("pod_4_alex_temperature")
    s = s.replace("    const preset = CONNECTORS[source] || {};\n",
                  "    const preset = _presetFor(source, config.entity);\n", 1)
    s = s.replace("// es-watchdog check id -> the few words", PRESET_FOR + "\n// es-watchdog check id -> the few words", 1)

    # 3. remaining fallbacks to the author's prefix
    s = s.replace('|| "%s"' % RULES["author_prefix"], '|| "eight_sleep_me"')

    # 4. gateway preset: self = left, the add-on's Solo/Dual helper
    s = s.replace('    sleep_score_entity: "sensor.eight_sleep_pod_right_sleep_score",\n'
                  '    partner_sleep_score_entity: "sensor.eight_sleep_pod_left_sleep_score",',
                  '    sleep_score_entity: "sensor.eight_sleep_pod_left_sleep_score",\n'
                  '    partner_sleep_score_entity: "sensor.eight_sleep_pod_right_sleep_score",')
    s = s.replace('dual_mode_entity: "input_boolean.eight_sleep_pod_dual_mode"',
                  'dual_mode_entity: "input_boolean.eight_plus_dual_mode"')

    # 5. card picker stub: find whichever Pod is there
    stub = (
        "  static getStubConfig(hass) {\n"
        "    const ids = Object.keys((hass && hass.states) || {});\n"
        "    const gw = ids.find((e) => e === \"climate.eight_sleep_pod_left\");\n"
        "    const fs = ids.find((e) => /^climate\\.pod_\\d+_left_temperature$/.test(e));\n"
        "    const cl = ids.find((e) => /^climate\\..*eight_sleep_side_climate$/.test(e));\n"
        "    if (gw) return { source: \"gateway\", entity: gw, layout: \"v2\" };\n"
        "    if (fs) return { source: \"freesleep\", entity: fs, layout: \"v2\" };\n"
        "    return { source: \"cloud\", entity: cl || \"climate.my_eight_sleep_side_climate\", layout: \"v2\" };\n"
        "  }\n")
    s = re.sub(r"  static getStubConfig\(\) \{\n.*?\n  \}\n", lambda m: stub, s, count=1, flags=re.S)

    # 6. comments: personal names, private notes, home paths
    s = re.sub(r"\s*\[\[proj-[^\]]*\]\]\.?", "", s)
    s = re.sub(r"~/(pod-[a-z-]+)", lambda m: "gateway/" + m.group(1).replace("pod-", ""), s)
    for pat, repl in RULES["regex_replace"]:
        s = re.sub(pat, repl, s)
    for old, new in RULES["text_replace"]:
        s = s.replace(old, new)
    return s


def check(name, text):
    hits = sorted({m.group(0) for m in LEAKS.finditer(text)})
    if hits:
        lines = [f"  {i + 1}: {l.strip()[:120]}" for i, l in enumerate(text.split("\n")) if LEAKS.search(l)]
        sys.exit(f"{name}: personal strings left {hits}\n" + "\n".join(lines[:30]))


def load_rules():
    global RULES, LEAKS
    if not os.path.isfile(RULES_PATH):
        sys.exit("The public build needs tools/publish_rules.local.json (maintainer-only, gitignored).\n"
                 "Copy tools/publish_rules.example.json and fill in your own household's names.")
    with open(RULES_PATH, encoding="utf-8") as f:
        RULES = json.load(f)
    LEAKS = re.compile(GENERIC_LEAKS + "|" + RULES["leaks"], re.I)


def main():
    load_rules()
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.join(os.path.dirname(ROOT), "eight-sleep-card"))
    a = ap.parse_args()
    src = os.path.abspath(a.src)
    card_path = os.path.join(src, "eight-sleep-card.js")
    if not os.path.isfile(card_path):
        sys.exit(f"no card at {card_path}")

    card = public_card(open(card_path, encoding="utf-8").read())
    check("eight-sleep-card.js", card)

    pub = os.path.join(src, "kiosk", "public")
    js = open(os.path.join(pub, "app.js"), encoding="utf-8").read()
    # the dev build's literal config is one household's; the add-on always serves /config.js
    js, n = re.subn(r"const CONFIG = \{.*?\n\};\n",
                    "// Card config comes from the add-on (/config.js), built from your setup answers.\n"
                    "const CONFIG = window.__POD_CONFIG || { type: \"custom:eight-sleep-card\", layout: \"v2\" };\n",
                    js, count=1, flags=re.S)
    if n != 1:
        sys.exit("app.js: couldn't find the `const CONFIG = {...};` block to replace")
    js = re.sub(r"~/(pod-[a-z-]+)", lambda m: "gateway/" + m.group(1).replace("pod-", ""), js)
    check("app.js", js)

    html = open(os.path.join(pub, "index.html"), encoding="utf-8").read()
    html = html.replace("?v=%%BUILD%%", "")
    html = html.replace('<script type="module" src="/eight-sleep-card.js',
                        '<script src="/config.js"></script>\n  <script type="module" src="/eight-sleep-card.js', 1)
    check("index.html", html)

    sw = open(os.path.join(pub, "sw.js"), encoding="utf-8").read()
    sw = sw.replace(', "/assets/eight-sleep-neuemontreal.woff2"', "")
    sw = re.sub(r'const CACHE = "[^"]+";', 'const CACHE = "eight-plus-app-v1";', sw)
    check("sw.js", sw)

    # every check passed — now write
    def put(path, text):
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)

    os.makedirs(os.path.join(BUNDLE, "assets"), exist_ok=True)
    put(os.path.join(ROOT, "eight-sleep-card.js"), card)
    put(os.path.join(BUNDLE, "eight-sleep-card.js"), card)
    for fn in ("es-bed.png", "es-pillows.png"):
        shutil.copy2(os.path.join(src, "images", fn), os.path.join(BUNDLE, "assets", fn))

    app = os.path.join(BUNDLE, "app")
    if os.path.isdir(app):
        shutil.rmtree(app)
    os.makedirs(os.path.join(app, "assets"))
    shutil.copytree(os.path.join(pub, "icons"), os.path.join(app, "icons"))
    for fn in ("es-bed.png", "es-pillows.png"):
        shutil.copy2(os.path.join(src, "images", fn), os.path.join(app, "assets", fn))
    put(os.path.join(app, "eight-sleep-card.js"), card)
    shutil.copy2(os.path.join(pub, "manifest.webmanifest"), app)
    put(os.path.join(app, "app.js"), js)
    put(os.path.join(app, "index.html"), html)
    put(os.path.join(app, "sw.js"), sw)

    ver = re.search(r"EIGHT-SLEEP-CARD %c v([\d.]+)", card)
    print(f"synced public card v{ver.group(1) if ver else '?'} from {src}")


if __name__ == "__main__":
    main()
