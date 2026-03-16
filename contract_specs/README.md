## Contract Specs

This directory stores seed XML files for instrument families that need stable,
non-expiring metadata for future IB/TWS integrations.

Each file is intentionally provisional. If a value is not fully confirmed, it
is marked with a `status` attribute such as `guess` or `needs-verification`.

Suggested usage:

- Load `catalog.xml` to discover available contract families.
- Load a single `*.xml` file for family-specific defaults.
- Treat expiry, strike, right, and underlying expiry month as runtime inputs.

Field intent:

- `identity`: human-facing description of the instrument family.
- `ib-contract`: default IB contract fields for the option itself.
- `underlying`: default IB contract fields for the underlying instrument.
- `variable-fields`: fields that change per series or per contract instance.
- `settlement`: descriptive hints for future pricing and assignment logic.
- `notes`: manual reminders for TWS verification.

Optional fields may appear when they help IB contract resolution:

- `trading-class`: often important for locking the correct option family.
- `contract-month-format`: expected format for the family-level contract month.
- `local-symbol-example`: example from TWS for a concrete contract instance.
- `last-trading-datetime`: optional runtime selector when a product needs it.
- `con-id`: optional direct IB contract identifier for a fully specified contract.
- `settlement-method` and `min-tick`: useful descriptive metadata from TWS.

Notes on underlyings:

- `IND` underlyings may omit `exchange` in these XML files when the TWS
  contract description does not expose one in a useful way for contract
  resolution.
- Option-level `exchange` and `trading-class` are usually more important than
  index-underlying venue fields when locking the correct IB option contract.

These files are seed data only and are not yet wired into application logic.
