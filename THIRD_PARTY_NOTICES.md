# Third-party notices

Eight+ is MIT licensed (see [LICENSE](LICENSE)). It includes or adapts the following work.

## free-sleep — MIT

<https://github.com/throwaway31265/free-sleep> · © free-sleep contributors

- `gateway/biometrics-tap/biometrics/` is vendored from free-sleep's `biometrics/` and patched to run beside
  the stock firmware (paths, no express server). Upstream file headers are kept.
- `eight_plus/app/pipeline/presence.py` ports free-sleep's presence detection (piezo baseline drift +
  capacitance z-score).

## HeartPy — MIT

<https://github.com/paulvangentcom/heartrate_analysis_python> · © Paul van Gent

Adapted inside free-sleep as `biometrics/heart/`, and carried here with it.

## eight_sleep (lukas-clarke) — MIT

<https://github.com/lukas-clarke/eight_sleep>

The card's raw heating-level → °C table (`RAW_TO_CELSIUS_MAP`) is taken from the integration's
`pyEight/constants.py`. Eight+ talks to the integration only through Home Assistant entities and its
`eight_sleep.*` services.

## hass-free-sleep (Mrtenz)

<https://github.com/Mrtenz/hass-free-sleep>

Not included — Eight+ reads the entities it creates. Listed because detection follows its unique-ID scheme.

---

"Eight Sleep" and "Pod" are trademarks of Eight Sleep, Inc. Eight+ is not affiliated with, endorsed by or
supported by Eight Sleep. The proprietary app font is not distributed.
