#!/usr/bin/env python3
"""
raw.py — decode the Pod's /persistent/*.RAW CBOR stream into capacitance rows.

Stock frank writes ~one RAW file every ~15 min and prunes old ones, so there's
usually only ~15 min of RAW on the Pod at any moment. The collector calls this
every 15 min; history accrues in the local store (same pattern as vitals).

The CBOR decode + piezo np.ptp run ON THE POD (its venv has cbor2 + numpy), which
also means we ship ~2 KB of decoded rows over SSH instead of catting 7 MB files.
The Pod emits TSV: `side  ts  out  cen  in  piezo_range`.
"""
import shlex
import subprocess

import config as C

# runs on the Pod under /opt/es-biometrics-tap/venv/bin/python.
# Emits, per second per side: cap out/cen/in + the piezo waveform's *mean* and
# p97-p3 spread. free-sleep's presence works on the MEAN (a body shifts the DC
# baseline slowly even when lying still; the AC peak-to-peak the old tap used is
# dominated by noise). See biometrics/piezo_data.py detect_presence_piezo.
_POD_DECODER = r'''
import sys, glob, io, struct
import cbor2
try:
    import numpy as np
    def feat(b):
        a = np.frombuffer(b, dtype="<i4").astype("f8")
        a = a[np.abs(a) < 5e6]
        if a.size < 8: return ("", "")
        return (float(a.mean()), float(np.percentile(a, 97) - np.percentile(a, 3)))
except Exception:
    def feat(b):
        n = len(b)//4
        if n < 8: return ("", "")
        v = [x for x in struct.unpack("<%di" % n, b[:n*4]) if abs(x) < 5_000_000]
        if len(v) < 8: return ("", "")
        vs = sorted(v)
        return (sum(v)/len(v), float(vs[int(len(vs)*0.97)] - vs[int(len(vs)*0.03)]))

cap = {}; piezo = {}
for path in sorted(f for f in glob.glob("/persistent/*.RAW") if not f.endswith("SEQNO.RAW")):
    try: raw = open(path, "rb").read()
    except Exception: continue
    buf = io.BytesIO(raw)
    while True:
        try: row = cbor2.load(buf)
        except Exception: break
        try: d = cbor2.loads(row["data"])
        except Exception: continue
        t = d.get("type"); ts = d.get("ts")
        try: ts = int(ts)
        except Exception: continue
        if t == "capSense":
            for side in ("left", "right"):
                s = d.get(side)
                if isinstance(s, dict) and s.get("status", "good") == "good":
                    cap[(side, ts)] = (s.get("out"), s.get("cen"), s.get("in"))
        elif t == "piezo-dual":
            for side, k in (("left", "left1"), ("right", "right1")):
                b = d.get(k)
                if b: piezo[(side, ts)] = feat(b)
w = sys.stdout.write
for (side, ts), (o, c, i) in sorted(cap.items()):
    pf = piezo.get((side, ts)) or piezo.get((side, ts-1)) or piezo.get((side, ts+1)) or ("", "")
    w("%s\t%d\t%s\t%s\t%s\t%s\t%s\n" % (side, ts, o, c, i, pf[0], pf[1]))
'''

POD_PY = "/opt/es-biometrics-tap/venv/bin/python"


def _ssh(remote_cmd, timeout=120):
    return subprocess.run(shlex.split(C.POD_SSH) + [remote_cmd],
                          capture_output=True, timeout=timeout)


def pull_rows():
    """Decode current Pod RAW files -> list of {side,timestamp,out,cen,in,piezo_range}."""
    pfx = "sudo -n " if C.POD_DB_NEEDS_SUDO else ""
    r = _ssh(f"{pfx}{POD_PY} - <<'EOF'\n{_POD_DECODER}\nEOF")
    if r.returncode != 0:
        raise RuntimeError(f"pod decode failed: {r.stderr.decode()[:200]}")
    out = []
    for line in r.stdout.decode().splitlines():
        p = line.split("\t")
        if len(p) != 7:
            continue
        side, ts, o, c, i, pa, pr = p
        out.append({
            "side": side, "timestamp": int(ts),
            "out": _f(o), "cen": _f(c), "in": _f(i),
            "piezo_avg": _f(pa), "piezo_range": _f(pr),
        })
    return out


def pull_and_store(con, store):
    rows = pull_rows()
    return store.upsert_cap(con, rows) if rows else 0


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


if __name__ == "__main__":
    import sys
    import store
    con = store.connect(C.STORE_DB)
    n = pull_and_store(con, store)
    con.commit()
    print(f"upserted {n}")
    for s in C.SIDES:
        r = con.execute('SELECT count(*),min(timestamp),max(timestamp),'
                        'round(avg(out),1),round(avg(cen),1),round(avg("in"),1),'
                        'round(min(piezo_range),0),round(max(piezo_range),0) '
                        'FROM cap WHERE side=?', (s,)).fetchone()
        print(f"{s}: {r[0]} rows {r[1]}..{r[2]}  cap≈{r[3]}/{r[4]}/{r[5]}  "
              f"piezo_range {r[6]}..{r[7]}")
    sys.exit(0)
