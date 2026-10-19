#!/usr/bin/env python3
"""
Minimal MQTT 3.1.1 publisher — pure stdlib, QoS 0, no third-party deps.

Lifted from eight-mqtt-bridge/frank-journal-mqtt.py so this pipeline runs on any
Mac (or box) without `paho-mqtt`. Publish-only: CONNECT, PUBLISH, PINGREQ.
"""
import socket
import threading
import time


def _rl(n):
    out = bytearray()
    while True:
        b = n % 128
        n //= 128
        if n:
            b |= 0x80
        out.append(b)
        if not n:
            return bytes(out)


def _str(s):
    b = s.encode("utf-8")
    return len(b).to_bytes(2, "big") + b


class MQTT:
    def __init__(self, host, port, user, password, client_id,
                 avail_topic=None, keepalive=45):
        self.host, self.port = host, port
        self.user, self.password = user, password
        self.client_id = client_id
        self.avail_topic = avail_topic
        self.keepalive = keepalive
        self.sock = None
        self.lock = threading.Lock()

    def connect(self):
        s = socket.create_connection((self.host, self.port), timeout=10)
        s.settimeout(10)
        flags = 0x80 | 0x40 | 0x02  # user, pass, clean session
        payload = _str(self.client_id)
        if self.avail_topic:
            flags |= 0x04 | 0x08  # will + will-retain
            payload += _str(self.avail_topic) + _str("offline")
        payload += _str(self.user) + _str(self.password)
        vh = _str("MQTT") + bytes([4, flags]) + self.keepalive.to_bytes(2, "big")
        pkt = bytes([0x10]) + _rl(len(vh) + len(payload)) + vh + payload
        s.sendall(pkt)
        resp = s.recv(4)
        if len(resp) < 4 or resp[0] != 0x20 or resp[3] != 0:
            raise ConnectionError(f"CONNACK failed: {resp!r}")
        self.sock = s
        if self.avail_topic:
            self.publish(self.avail_topic, "online", retain=True)

    def publish(self, topic, payload, retain=False):
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        hdr = 0x30 | (0x01 if retain else 0)
        body = _str(topic) + payload
        pkt = bytes([hdr]) + _rl(len(body)) + body
        with self.lock:
            if not self.sock:
                raise ConnectionError("not connected")
            self.sock.sendall(pkt)

    def disconnect(self):
        with self.lock:
            if self.sock:
                try:
                    self.sock.sendall(b"\xe0\x00")  # DISCONNECT -> suppress the will
                except OSError:
                    pass

    def ping(self):
        with self.lock:
            if self.sock:
                self.sock.sendall(b"\xc0\x00")

    def close(self):
        with self.lock:
            if self.sock:
                try:
                    self.sock.close()
                finally:
                    self.sock = None


def publish_once(cfg, messages):
    """messages: iterable of (topic, payload, retain). One connect/flush/close."""
    m = MQTT(cfg["host"], cfg["port"], cfg["user"], cfg["password"],
             cfg.get("client_id", "pod-sleep-pipeline"), cfg.get("avail_topic"))
    m.connect()
    try:
        for topic, payload, retain in messages:
            m.publish(topic, payload, retain=retain)
        time.sleep(0.5)  # let the socket flush before we close
        m.disconnect()
    finally:
        m.close()
