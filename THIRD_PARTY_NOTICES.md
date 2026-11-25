# Third-party notices

Eight+ is MIT licensed (see [LICENSE](LICENSE)). It includes or adapts the following work.

## free-sleep — MIT

<https://github.com/throwaway31265/free-sleep> · © free-sleep contributors

- `gateway/biometrics-tap/biometrics/` is vendored from free-sleep's `biometrics/` and patched to run beside
  the stock firmware (paths, no express server). Upstream file headers are kept.
- `eight_plus/app/pipeline/presence.py` ports free-sleep's presence detection (piezo baseline drift +
  capacitance z-score).

free-sleep is released under the MIT License inside its own "Open Source Disclaimer and License Agreement"
(no affiliation with Eight Sleep, use at your own risk, no liability). The full upstream text is kept beside the
vendored code in [`gateway/biometrics-tap/biometrics/LICENSE-free-sleep.md`](gateway/biometrics-tap/biometrics/LICENSE-free-sleep.md).

## HeartPy — MIT

<https://github.com/paulvangentcom/heartrate_analysis_python> · © Paul van Gent

Adapted inside free-sleep as `biometrics/heart/`, and carried here with it. Licence:
[`gateway/biometrics-tap/biometrics/heart/LICENSE-HeartPy`](gateway/biometrics-tap/biometrics/heart/LICENSE-HeartPy).

```
MIT License

Copyright (c) 2021 Paul van Gent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## eight_sleep (lukas-clarke) — MIT

<https://github.com/lukas-clarke/eight_sleep>

The card's raw heating-level → °C table (`RAW_TO_CELSIUS_MAP`) is taken from the integration's
`pyEight/constants.py`. Eight+ talks to the integration only through Home Assistant entities and its
`eight_sleep.*` services.

```
MIT License

Copyright (c) 2023 Lukas

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Lucide — ISC (some icons Feather — MIT)

<https://github.com/lucide-icons/lucide>

The card inlines a handful of Lucide icon paths (marked `Lucide` in `eight-sleep-card.js`). Some Lucide icons
derive from [Feather](https://github.com/feathericons/feather).

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

```
The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## hass-free-sleep (Mrtenz)

<https://github.com/Mrtenz/hass-free-sleep>

MIT. Not included — Eight+ reads the entities it creates. Listed because detection follows its unique-ID scheme.

---

"Eight Sleep" and "Pod" are trademarks of Eight Sleep, Inc. Eight+ is not affiliated with, endorsed by or
supported by Eight Sleep. The proprietary app font is not distributed.
