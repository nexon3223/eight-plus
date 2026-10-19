#!/bin/bash
# pod-es-led/uninstall.sh -- run ON the Pod as root. Removes the LED service and
# hands the front LED back to Capybara.
set -uo pipefail
[ "$EUID" -eq 0 ] || { echo "run as root"; exit 1; }

systemctl disable --now es-led.service 2>/dev/null || true
rm -f /etc/systemd/system/es-led.service
systemctl daemon-reload

# release the chip (software shutdown) so Capybara's indicator resumes
python3 - <<'EOF' 2>/dev/null || true
import fcntl, os, time
fd = os.open("/dev/i2c-1", os.O_RDWR); fcntl.ioctl(fd, 0x0703, 0x53)
os.write(fd, bytes((0x4F, 0xC5))); time.sleep(0.01); os.write(fd, bytes((0x01, 0x00)))
os.close(fd)
EOF

rm -rf /opt/es-led
echo "es-led removed. A Pod reboot (or the next wifi state change) restores Capybara's LED fully."
