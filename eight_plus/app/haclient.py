"""
Home Assistant client — pure stdlib (WebSocket + REST).

Inside the add-on it talks to Core through the Supervisor proxy with SUPERVISOR_TOKEN
(no long-lived token for the user to make). For development on another machine set
HA_URL=http://homeassistant.local:8123 and HA_TOKEN=<long-lived token>.
"""
import base64
import json
import os
import socket
import ssl
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def endpoints():
    sup = os.environ.get("SUPERVISOR_TOKEN")
    if sup:
        return {"rest": "http://supervisor/core/api", "ws": "ws://supervisor/core/websocket",
                "token": sup, "supervisor": "http://supervisor", "in_addon": True}
    url = os.environ.get("HA_URL", "http://homeassistant.local:8123").rstrip("/")
    ws = url.replace("https://", "wss://").replace("http://", "ws://") + "/api/websocket"
    return {"rest": url + "/api", "ws": ws, "token": os.environ.get("HA_TOKEN", ""),
            "supervisor": None, "in_addon": False}


# ───────────────────────────────────────────────────────────── websocket framing
class SockReader:
    def __init__(self, sock, seed=b""):
        self.s, self.b = sock, bytearray(seed)

    def read(self, n):
        while len(self.b) < n:
            c = self.s.recv(65536)
            if not c:
                raise EOFError()
            self.b += c
        o = bytes(self.b[:n])
        del self.b[:n]
        return o


def ws_recv(reader):
    """(opcode, payload) for one message — unmasks, reassembles fragments, skips ping/pong."""
    data, first = bytearray(), None
    while True:
        h = reader.read(2)
        fin, op = h[0] & 0x80, h[0] & 0x0F
        masked, ln = h[1] & 0x80, h[1] & 0x7F
        if ln == 126:
            ln = struct.unpack(">H", reader.read(2))[0]
        elif ln == 127:
            ln = struct.unpack(">Q", reader.read(8))[0]
        mask = reader.read(4) if masked else None
        payload = reader.read(ln)
        if masked:
            payload = bytes(p ^ mask[i % 4] for i, p in enumerate(payload))
        if op == 0x8:
            return 0x8, b""
        if op in (0x9, 0xA):
            continue
        first = op if first is None else first
        data += payload
        if fin:
            return first, bytes(data)


def ws_send(sock, data, opcode=0x1, mask=False):
    if isinstance(data, str):
        data = data.encode()
    n = len(data)
    h = bytearray([0x80 | opcode])
    mbit = 0x80 if mask else 0
    if n < 126:
        h.append(mbit | n)
    elif n < 65536:
        h.append(mbit | 126)
        h += struct.pack(">H", n)
    else:
        h.append(mbit | 127)
        h += struct.pack(">Q", n)
    if mask:
        m = os.urandom(4)
        sock.sendall(bytes(h) + m + bytes(b ^ m[i % 4] for i, b in enumerate(data)))
    else:
        sock.sendall(bytes(h) + data)


def ws_open(url, token, timeout=10):
    """Client-role WS to HA; returns (sock, reader) after auth_ok."""
    u = urllib.parse.urlparse(url)
    port = u.port or (443 if u.scheme == "wss" else 80)
    sk = socket.create_connection((u.hostname, port), timeout=timeout)
    if u.scheme == "wss":
        sk = ssl.create_default_context().wrap_socket(sk, server_hostname=u.hostname)
    key = base64.b64encode(os.urandom(16)).decode()
    sk.sendall((f"GET {u.path or '/'} HTTP/1.1\r\nHost: {u.hostname}:{port}\r\nUpgrade: websocket\r\n"
                f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        c = sk.recv(65536)
        if not c:
            raise EOFError("HA closed during handshake")
        buf += c
    if b" 101 " not in buf.split(b"\r\n", 1)[0]:
        raise ConnectionError("websocket upgrade refused: " + buf.split(b"\r\n", 1)[0].decode(errors="replace"))
    reader = SockReader(sk, buf.split(b"\r\n\r\n", 1)[1])
    ws_recv(reader)  # auth_required
    ws_send(sk, json.dumps({"type": "auth", "access_token": token}), mask=True)
    while True:
        _op, msg = ws_recv(reader)
        m = json.loads(msg.decode())
        if m.get("type") == "auth_ok":
            break
        if m.get("type") == "auth_invalid":
            raise PermissionError("Home Assistant rejected the token: " + str(m.get("message")))
    sk.settimeout(None)
    return sk, reader


# ───────────────────────────────────────────────────────────── client
class HAError(RuntimeError):
    pass


class HA:
    """One long-lived WS connection: call() for request/response, subscribe() for events.
    Reconnects on drop and re-subscribes; call() raises if HA is unreachable."""

    def __init__(self, ep=None, log=print):
        self.ep = ep or endpoints()
        self.log = log
        self._sock = None
        self._id = 0
        self._pending = {}
        self._subs = {}          # local key -> (msg, callback, remote id)
        self._lock = threading.RLock()
        self._up = threading.Event()
        self._stop = False
        threading.Thread(target=self._run, daemon=True, name="ha-ws").start()

    # --- lifecycle
    def _run(self):
        backoff = 1
        while not self._stop:
            try:
                sock, reader = ws_open(self.ep["ws"], self.ep["token"])
                with self._lock:
                    self._sock = sock
                    self._up.set()
                backoff = 1
                self._resubscribe()
                while True:
                    op, msg = ws_recv(reader)
                    if op == 0x8:
                        break
                    self._dispatch(json.loads(msg.decode()))
            except PermissionError as e:
                self.log("HA auth failed:", e)
                backoff = 30
            except Exception as e:  # noqa: BLE001
                if self._up.is_set():
                    self.log("HA connection lost:", repr(e))
            with self._lock:
                self._up.clear()
                self._sock = None
                for ev in self._pending.values():
                    ev["error"] = "disconnected"
                    ev["event"].set()
                self._pending.clear()
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)

    @property
    def connected(self):
        return self._up.is_set()

    def wait(self, timeout=30):
        return self._up.wait(timeout)

    def _dispatch(self, m):
        if m.get("type") == "event":
            for _k, (_msg, cb, rid) in list(self._subs.items()):
                if rid == m.get("id"):
                    try:
                        cb(m["event"])
                    except Exception as e:  # noqa: BLE001
                        self.log("event callback failed:", repr(e))
            return
        p = self._pending.pop(m.get("id"), None)
        if p:
            p["result"] = m
            p["event"].set()

    def _send(self, msg):
        with self._lock:
            if not self._sock:
                raise HAError("not connected to Home Assistant")
            self._id += 1
            msg = dict(msg, id=self._id)
            ws_send(self._sock, json.dumps(msg), mask=True)
            return self._id

    # --- API
    def call(self, msg, timeout=60):
        if not self._up.wait(timeout):
            raise HAError("Home Assistant is not reachable")
        ev = {"event": threading.Event()}
        with self._lock:
            rid = self._send(msg)
            self._pending[rid] = ev
        if not ev["event"].wait(timeout):
            self._pending.pop(rid, None)
            raise HAError(f"timed out waiting for {msg.get('type')}")
        if ev.get("error"):
            raise HAError(ev["error"])
        r = ev["result"]
        if not r.get("success", True):
            e = r.get("error") or {}
            raise HAError(f"{msg.get('type')}: {e.get('code')} {e.get('message')}")
        return r.get("result")

    def subscribe(self, key, msg, callback):
        with self._lock:
            self._subs[key] = (msg, callback, None)
            if self._sock:
                self._subs[key] = (msg, callback, self._send(msg))

    def _resubscribe(self):
        with self._lock:
            for k, (msg, cb, _rid) in list(self._subs.items()):
                self._subs[k] = (msg, cb, self._send(msg))

    def service(self, domain, service, data=None, target=None, timeout=60):
        m = {"type": "call_service", "domain": domain, "service": service, "service_data": data or {}}
        if target:
            m["target"] = target
        return self.call(m, timeout)

    def states(self):
        return {s["entity_id"]: s for s in self.call({"type": "get_states"})}

    def registry(self):
        return self.call({"type": "config/entity_registry/list"})

    def services(self):
        return self.call({"type": "get_services"})

    def config(self):
        return self.call({"type": "get_config"})

    # --- REST (for the few things the WS API doesn't expose)
    def rest(self, method, path, body=None, timeout=120):
        url = self.ep["rest"] + path
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.ep['token']}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            raise HAError(f"{method} {path}: HTTP {e.code} {e.read()[:300]!r}") from e

    def check_config(self):
        """{'result': 'valid'|'invalid', 'errors': str|None}"""
        return self.rest("POST", "/config/core/check_config", timeout=180)

    def supervisor(self, path):
        """GET a Supervisor API path (add-on only), e.g. /services/mqtt."""
        if not self.ep.get("supervisor"):
            return None
        req = urllib.request.Request(self.ep["supervisor"] + path,
                                     headers={"Authorization": f"Bearer {self.ep['token']}"})
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return (json.loads(r.read()) or {}).get("data")
        except Exception:  # noqa: BLE001
            return None
