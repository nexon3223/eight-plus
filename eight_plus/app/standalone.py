"""
The standalone Pod app — the card as a full-screen, no-login web app for phones on your LAN
(Add to Home Screen). Off by default; switched on from the Eight+ panel.

No login means the proxy is the security boundary, so it is scoped to THIS install:
  • get_states / state_changed / subscribe_entities only ever carry the bed's own entities
    (everything Eight+ created + what detection found for the Pod), never the rest of the house
  • call_service is allowed only when every target is one of those entities
  • get_config is stripped of location, and nothing else from the WS API is forwarded
"""
import base64
import hashlib
import json
import mimetypes
import os
import re
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from haclient import SockReader, ws_open, ws_recv, ws_send, GUID

ALLOWED_TYPES = {"get_states", "get_config", "subscribe_events", "subscribe_entities", "unsubscribe_events",
                 "ping", "call_service", "history/history_during_period", "recorder/statistics_during_period"}
SERVICE_DOMAINS = {"climate", "eight_sleep", "input_boolean", "input_number", "input_datetime", "input_text",
                   "input_select", "counter", "switch", "button", "light", "script", "homeassistant"}
HA_SAFE = {"update_entity", "turn_on", "turn_off", "toggle"}   # homeassistant.* — still entity-scoped


class Scope:
    def __init__(self):
        self.entities = set()
        self.config = {}

    def load(self, st):
        ents = set(st.get("entities") or [])
        for card in (st.get("cards") or {}).values():
            for k, v in card.items():
                if isinstance(v, str) and re.fullmatch(r"[a-z_]+\.[a-z0-9_]+", v):
                    ents.add(v)
                elif isinstance(v, list):
                    for it in v:
                        if isinstance(it, dict) and isinstance(it.get("entity"), str):
                            ents.add(it["entity"])
        for s in ((st.get("answers") or {}).get("bed") or {}).get("sides", {}).values():
            ents.update(v for v in s.values() if isinstance(v, str))
        for v in (((st.get("answers") or {}).get("bed") or {}).get("shared") or {}).values():
            if isinstance(v, str):
                ents.add(v)
        # (lights aren't in scope: pick the sunrise light from the HA dashboard, not the LAN app)
        self.entities = ents
        self.config = st.get("cards") or {}
        return self


def make_handler(public_dir, scope, ha_ep):
    class H(BaseHTTPRequestHandler):
        server_version = "EightPlusApp/1.0"
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/ws" and (self.headers.get("Upgrade") or "").lower() == "websocket":
                return self._ws()
            if path == "/config.js":
                return self._config_js()
            if path == "/":
                path = "/index.html"
            full = os.path.normpath(os.path.join(public_dir, path.lstrip("/")))
            if not full.startswith(public_dir) or not os.path.isfile(full):
                self.send_error(404)
                return
            body = open(full, "rb").read()
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if full.endswith(".js"):
                ctype = "text/javascript"
            elif full.endswith(".webmanifest"):
                ctype = "application/manifest+json"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache" if full.endswith((".html", ".js", ".webmanifest"))
                             else "public, max-age=86400")
            self.end_headers()
            self.wfile.write(body)

        def _config_js(self):
            q = dict(p.split("=", 1) for p in (self.path.split("?", 1) + [""])[1].split("&") if "=" in p)
            cards = scope.config
            slug = q.get("who") if q.get("who") in cards else next(iter(cards), None)
            cfg = dict(cards.get(slug) or {})
            # the app serves the art itself
            for k in ("bed_image", "pillow_image"):
                if cfg.get(k):
                    cfg[k] = "/assets/" + cfg[k].rsplit("/", 1)[-1]
            body = ("window.__POD_CONFIG = " + json.dumps(cfg) + ";\nwindow.__POD_PEOPLE = "
                    + json.dumps(list(cards)) + ";\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        # ---- the scoped proxy
        def _ws(self):
            key = self.headers["Sec-WebSocket-Key"]
            acc = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
            self.send_response(101, "Switching Protocols")
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", acc)
            self.end_headers()
            self.wfile.flush()
            client = self.connection
            creader = SockReader(client)
            try:
                ha, hreader = ws_open(ha_ep["ws"], ha_ep["token"])
            except Exception as e:  # noqa: BLE001
                ws_send(client, json.dumps({"type": "kiosk_error", "message": f"HA connect failed: {e}"}))
                return
            kinds = {}          # request id -> type, so replies can be filtered
            stop = threading.Event()

            def filt(m):
                t = m.get("type")
                if t == "result" and m.get("success"):
                    k = kinds.pop(m.get("id"), None)
                    if k == "get_states":
                        m["result"] = [s for s in m["result"] or [] if s.get("entity_id") in scope.entities]
                    elif k == "get_config":
                        r = dict(m["result"] or {})
                        for f in ("latitude", "longitude", "elevation", "location_name", "allowlist_external_dirs",
                                  "allowlist_external_urls", "whitelist_external_dirs", "external_url", "internal_url"):
                            r.pop(f, None)
                        m["result"] = r
                    elif k in ("history/history_during_period", "recorder/statistics_during_period"):
                        m["result"] = {e: v for e, v in (m["result"] or {}).items() if e in scope.entities}
                    return m
                if t == "event":
                    ev = m.get("event") or {}
                    if ev.get("event_type") == "state_changed":
                        return m if (ev.get("data") or {}).get("entity_id") in scope.entities else None
                    if any(k in ev for k in ("a", "c", "r")):            # subscribe_entities
                        for k in ("a", "c"):
                            if k in ev:
                                ev[k] = {e: v for e, v in ev[k].items() if e in scope.entities}
                        if "r" in ev:
                            ev["r"] = [e for e in ev["r"] if e in scope.entities]
                        return m
                    return None
                return m

            def up():
                try:
                    while not stop.is_set():
                        op, msg = ws_recv(hreader)
                        if op == 0x8:
                            break
                        m = filt(json.loads(msg.decode()))
                        if m is not None:
                            ws_send(client, json.dumps(m))
                except Exception:  # noqa: BLE001
                    pass
                finally:
                    stop.set()
                    try:
                        client.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass

            threading.Thread(target=up, daemon=True).start()
            try:
                while not stop.is_set():
                    op, msg = ws_recv(creader)
                    if op == 0x8:
                        break
                    try:
                        obj = json.loads(msg.decode())
                    except ValueError:
                        continue
                    why = self._deny(obj)
                    if why:
                        ws_send(client, json.dumps({"id": obj.get("id"), "type": "result", "success": False,
                                                    "error": {"code": "not_allowed", "message": why}}))
                        continue
                    if obj.get("type") == "subscribe_events" and obj.get("event_type") != "state_changed":
                        obj["event_type"] = "state_changed"
                    kinds[obj.get("id")] = obj.get("type")
                    ws_send(ha, json.dumps(obj), mask=True)
            except Exception:  # noqa: BLE001
                pass
            finally:
                stop.set()
                for s in (ha, client):
                    try:
                        s.close()
                    except OSError:
                        pass

        @staticmethod
        def _deny(obj):
            t = obj.get("type")
            if t == "call_service" and os.environ.get("EIGHT_PLUS_DRY_RUN") == "1":
                return "dry run — service calls are not sent"
            if t not in ALLOWED_TYPES:
                return f"{t} is not available in the Pod app"
            if t == "subscribe_entities":
                ids = obj.get("entity_ids") or []
                obj["entity_ids"] = [e for e in ids if e in scope.entities] or sorted(scope.entities)
            if t in ("history/history_during_period", "recorder/statistics_during_period"):
                key = "entity_ids" if "entity_ids" in obj else "statistic_ids"
                obj[key] = [e for e in obj.get(key) or [] if e in scope.entities]
                if not obj[key]:
                    return "no bed entities requested"
            if t != "call_service":
                return None
            dom, svc = obj.get("domain"), obj.get("service")
            if dom not in SERVICE_DOMAINS or (dom == "homeassistant" and svc not in HA_SAFE):
                return f"{dom}.{svc} is not available in the Pod app"
            ids = []
            for src in (obj.get("service_data") or {}, obj.get("target") or {}):
                v = src.get("entity_id")
                ids += [v] if isinstance(v, str) else list(v or [])
            if not ids:
                return f"{dom}.{svc} needs a bed entity as its target"
            bad = [e for e in ids if e not in scope.entities]
            return f"{', '.join(bad)} is outside the bed" if bad else None

    return H


class StandaloneApp:
    def __init__(self, public_dir, ha_ep, port=8098, log=print):
        self.public, self.ep, self.port, self.log = os.path.realpath(public_dir), ha_ep, port, log
        self.scope = Scope()
        self.httpd = None

    def update_scope(self, state):
        self.scope.load(state)

    def start(self):
        if self.httpd:
            return
        mimetypes.add_type("text/javascript", ".js")
        self.httpd = ThreadingHTTPServer(("0.0.0.0", self.port), make_handler(self.public, self.scope, self.ep))
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever, daemon=True, name="standalone").start()
        self.log(f"Pod app on :{self.port} ({len(self.scope.entities)} entities in scope)")

    def stop(self):
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
            self.httpd = None
