# Security

## Reporting a problem

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/nexon3223/eight-plus/security/advisories/new),
not in a public issue. I'll reply as soon as I can.

## What to know before you install

- **The Pod gateway runs as root on your Pod.** Getting it there means rooting the Pod, which may void your
  warranty. The gateway's services listen only on your network and publish to your own MQTT broker, using the
  credentials you give the installer (stored in `/etc/eight-plus/gateway.conf` on the Pod).
- **The Pod app** (optional, off by default) is a no-login copy of the card for phones on your Wi-Fi. Anyone on
  your network can use it to control the bed. Its proxy can only see and call the bed's own entities.
- **The Home Assistant app** talks to Home Assistant through the Supervisor. It writes YAML into
  `packages/eight_plus/` and backs up `configuration.yaml` first.
- Eight+ is provided as is, with no warranty (see [LICENSE](LICENSE)).
