# Contributing

Bug reports and pull requests are welcome.

- **Bugs:** open an [issue](https://github.com/nexon3223/eight-plus/issues/new/choose) with your backend
  (cloud, free-sleep or gateway), your Pod model, your Home Assistant version and the Eight+ app log.
- **Pull requests:** keep them small and run the tests first:

  ```bash
  pip install pyyaml jinja2
  python3 tests/test_generator.py && python3 tests/test_installer.py \
    && python3 tests/test_standalone.py && python3 tests/test_detect.py
  ```

- The card and the gateway are synced in from the maintainer's own repos by `tools/sync_card.py` and
  `tools/sync_gateway.py`, so a change to `eight-sleep-card.js` or `gateway/` may need porting back there. Say
  so in the PR and I'll handle it.
