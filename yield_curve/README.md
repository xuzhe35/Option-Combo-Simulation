# Unified USD reference discount curve

This directory is the single runtime source for discounting in the portfolio,
Chart Lab, historical replay, and IV Term Structure surfaces.

## Daily use

For normal desktop use, double-click `update_yield_curve.bat` on Windows or
`update_yield_curve_mac.command` on macOS. The launcher performs one official-
source refresh, prints the resulting local snapshot status, and keeps an
interactive terminal open so failures remain visible.

Developer CLI equivalents from the repository root:

```bash
.venv/bin/python -m yield_curve update
.venv/bin/python -m yield_curve status
```

`python3` also works when it is the interpreter used to run the backends. The
updater needs no API key. It downloads from the official New York Fed SOFR API
and the official U.S. Treasury Daily Treasury Par Yield Curve XML feed.

The two websocket backends never implement source downloads. When
`latest.json` is missing or from an older New York market date, a backend may
start the independent updater once with its own `sys.executable`. Failure keeps
the last complete snapshot; with no snapshot, the visible manual continuous
rate remains the final fallback.

## Curve policy

- `0–30` calendar days: latest official overnight SOFR, held flat as a future
  overnight-rate proxy. SOFR's ACT/360 simple quote `s` is converted to an
  ACT/365F continuously compounded rate with
  `z = 365 * ln(1 + s / 360)`.
- `30–46` days (or the first available CMT node after 30 days): smoothstep
  transition in instantaneous-forward space from SOFR to the Treasury proxy
  slope. There is no hard 30-day switch or nearest-node lookup.
- Beyond the transition: Treasury CMT proxy forward slope, with the discount
  level anchored to SOFR at 30 days.

The canonical value is `discountFactor = D(T)`. Display zero rates are derived
continuous ACT/365F values, and interpolation is linear in `-ln(D)`.

The official 30/90/180-day SOFR Averages are stored only under
`sources.sofr.backwardLookingDiagnostics`. They are backward-looking realized
compounded averages, not future 30/90/180-day curve nodes.

Treasury CMT values are bond-equivalent par yields, not official zero rates.
Their compounding-normalized values remain explicitly marked as proxies. This
hybrid is therefore a transparent short-dated reference curve, not a claimed
bootstrapped SOFR OIS curve.

## Files

Runtime files are intentionally ignored by Git:

```text
yield_curve/data/latest.json
yield_curve/data/snapshots/YYYY/YYYY-MM-DD.json
yield_curve/data/raw/sofr/YYYY/YYYY-MM-DD.json
yield_curve/data/raw/treasury/YYYY/YYYY-MM-DD.json
```

Writes use a same-directory temporary file, `fsync`, and `os.replace`.
Historical reads select the latest `curveAsOf` on or before the replay date and
never trigger a current-data download. Old `rates.db` Treasury curves remain a
read-only, explicitly degraded migration fallback for dates not yet backfilled
to JSON; the scalar rate is then derived from that same curve rather than mixed
with another source.

## Semantics that must remain separate

- Discount: `D(T)` / discount `r(T)` from this snapshot.
- Forward: outright `F(T)`; FOP uses the bound futures quote and INDEX uses
  discount-aware put-call parity.
- Carry: `ln(F/S)/T`, which includes dividend/borrow/basis effects and is not a
  substitute for discount `r`.
- Variance clock: calendar/trading/weighted time and weekend lambda. It never
  changes the calendar-time exponent used by `D(T)`.
