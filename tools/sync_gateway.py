#!/usr/bin/env python3
"""
Pull the Pod gateway services from their development repos into gateway/, ready to publish.

    python3 tools/sync_gateway.py [--src ~]

Copies (never edits the source repos, never copies their git history):
  pod-franken-proxy/   -> gateway/franken-proxy/     local temperature control (climate per side)
  pod-biometrics-tap/  -> gateway/biometrics-tap/    presence + vitals from the Pod's raw stream
  pod-watchdog/        -> gateway/watchdog/          health checks + self-repair
  pod-es-led/          -> gateway/led/               the Pod's front LED as an HA light (optional)

On the way:
  • the hard-coded MQTT_HOST/PORT/USER/PASS block becomes a loader for /etc/eight-plus/gateway.conf
    (written by gateway/install.sh), overridable by MQTT_* environment variables
  • a username_pw_set() call only happens when a user is configured
  • the author's ssh key name, Pod address and home paths in READMEs/installers become placeholders
and nothing is written if a literal password, a private-network address or a home path survives.
"""
import argparse
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(ROOT, "gateway")

PARTS = {  # source repo -> (dest dir, files to take)
    "pod-franken-proxy": ("franken-proxy", ["README.md", "franken_proxy.py", "install.sh", "uninstall.sh",
                                            "systemd/es-franken-proxy.service"]),
    "pod-biometrics-tap": ("biometrics-tap", None),          # None = every tracked-looking file
    "pod-watchdog": ("watchdog", ["es_watchdog.py", "install.sh", "uninstall.sh",
                                  "systemd/es-watchdog.service", "systemd/journald-es.conf"]),
    "pod-es-led": ("led", ["README.md", "es_led.py", "install.sh", "uninstall.sh", "systemd/es-led.service"]),
}
SKIP = re.compile(r"(^|/)(\.git|__pycache__|\.DS_Store|.*\.pyc|.*\.RAW|data)(/|$)")

LOADER = '''# MQTT broker — /etc/eight-plus/gateway.conf (KEY=value lines, written by gateway/install.sh),
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
'''

MQTT_BLOCK = re.compile(r'^MQTT_HOST = "[^"]*"\nMQTT_PORT = \d+\nMQTT_USER = "[^"]*"\nMQTT_PASS = "[^"]*"\n', re.M)

DOC_FIXES = [
    (r"ssh -i ~/\.ssh/eight_pod -p 8822 rewt@192\.168\.\d+\.\d+", "ssh -p 8822 rewt@<pod-ip>"),
    (r"ssh -p 8822 rewt@192\.168\.\d+\.\d+", "ssh -p 8822 rewt@<pod-ip>"),
    (r"rewt@192\.168\.\d+\.\d+", "rewt@<pod-ip>"),
    (r"192\.168\.\d+\.\d+", "<home-assistant-ip>"),
    (r"tar czf - -C ~/pod-([a-z-]+)", lambda m: f"tar czf - -C gateway/{_dest_of('pod-' + m.group(1))}"),
    (r"~/pod-([a-z-]+)", lambda m: f"gateway/{_dest_of('pod-' + m.group(1))}"),
    # private-history paragraphs and pointers to folders that aren't published
    (r"Born out of the [^\n]*\n(?:[^\n]+\n)*\n", ""),
    (r" \(see `\.\./Sleep Insights` design\)", ""),
    (r"For \*\*temperature control\*\*, add the stock `eight_sleep` HACS integration in\nHA — it does climate \+ presence with no subscription\.",
     "For **temperature control**, install `../franken-proxy` (or just run `../install.sh`)."),
]

LEAKS = [
    (re.compile(r'MQTT_PASS\s*=\s*"[^"]+"'), "a literal MQTT password"),
    (re.compile(r"192\.168\.\d+\.\d+"), "a private-network address"),
    (re.compile(r"/Users/(?!ds/)|/home/(?!rewt|dac)"), "a home path"),
    (re.compile(r"\[\[proj-"), "a private-notes link"),
    (re.compile(r"pod3-freesleep-fix|Sleep Insights"), "a pointer to an unpublished folder"),
]


def _dest_of(repo):
    return PARTS.get(repo, (repo.replace("pod-", ""),))[0]


def _patch_py(text, name):
    text, n = MQTT_BLOCK.subn(LOADER, text, count=1)
    if n != 1:
        sys.exit(f"{name}: couldn't find the MQTT_HOST/PORT/USER/PASS block")
    if not re.search(r"^import os$", text, re.M):
        sys.exit(f"{name}: expected `import os`")
    text = re.sub(r"^(\s*)(\w+)\.username_pw_set\(MQTT_USER, MQTT_PASS\)$",
                  r"\1if MQTT_USER:\n\1    \2.username_pw_set(MQTT_USER, MQTT_PASS)", text, flags=re.M)
    return text


def _fix_doc(text):
    for pat, repl in DOC_FIXES:
        text = re.sub(pat, repl, text)
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.expanduser("~"))
    a = ap.parse_args()

    out = {}  # relative dest path -> bytes|str
    for repo, (dest, files) in PARTS.items():
        src = os.path.join(a.src, repo)
        if not os.path.isdir(src):
            sys.exit(f"missing {src}")
        if files is None:
            files = []
            for dp, dns, fns in os.walk(src):
                for fn in fns:
                    rel = os.path.relpath(os.path.join(dp, fn), src)
                    if not SKIP.search(rel):
                        files.append(rel)
        for rel in sorted(files):
            path = os.path.join(src, rel)
            key = os.path.join(dest, rel)
            if rel.endswith((".py", ".sh", ".md", ".service", ".conf", ".txt", ".json")):
                text = open(path, encoding="utf-8").read()
                if MQTT_BLOCK.search(text):
                    text = _patch_py(text, key)
                text = _fix_doc(text)
                for rx, what in LEAKS:
                    m = rx.search(text)
                    if m:
                        sys.exit(f"{key}: {what} survived: {m.group(0)[:60]}")
                out[key] = text
            else:
                out[key] = open(path, "rb").read()

    # every check passed — replace the per-service folders (gateway/ top-level files are hand-written)
    for dest, _ in PARTS.values():
        shutil.rmtree(os.path.join(DEST, dest), ignore_errors=True)
    for key, data in out.items():
        p = os.path.join(DEST, key)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w" if isinstance(data, str) else "wb", **({"encoding": "utf-8"} if isinstance(data, str) else {})) as f:
            f.write(data)
        if p.endswith(".sh"):
            os.chmod(p, 0o755)
    print(f"synced {len(out)} gateway files into {DEST}")


if __name__ == "__main__":
    main()
