# PMS report adapter decision

> This record classifies discovery evidence. It does not authorize code,
> migrations, production data access, or rollout. Store completed copies in the
> approved private evidence location.

## Candidate boundary

- Candidate name/version:
- Supported PMS products/versions:
- Supported properties or property cohort:
- Report families and structural fingerprints:
- Explicitly unsupported variants:
- Evidence records reviewed:

## Gate

- [ ] Consent, property ownership, sender, retention, and access are recorded.
- [ ] Delivery is repeatable without credentials or browser automation.
- [ ] At least three normal cycles exist per property.
- [ ] A shared candidate has matching evidence from at least two properties.
- [ ] Grain, fields, units, nulls, identifiers, and totals are confirmed.
- [ ] Business date, timezone, audit cutoff, as-of, and freshness are clear.
- [ ] Missing, late, duplicate, correction, out-of-order, and backfill rules are clear.
- [ ] PMS facts remain physically separate from `room_work`.
- [ ] Synthetic/redacted success, variation, correction, and rejection fixtures are feasible.
- [ ] Malformed or incomplete input can fail closed without partial success.
- [ ] Health, rollout, rollback, ownership, and version boundaries are named.

## Decision

- Disposition: shared / property-specific / continue discovery / unsupported
- Evidence supporting the decision:
- Contradictory evidence:
- Blocking unknowns:
- Stop conditions triggered:
- Evidence required to resume:
- Future adapter owner:
- Hotel operator confirmation:
- Security/privacy confirmation:
- Decision date:

## Later implementation proposal inputs

- Proposed canonical facts only (never `room_work` fields):
- Reconciliation and all-or-fail rule:
- Lineage and receipt rule:
- Correction/supersession rule:
- Parser/version fingerprint rule:
- Shadow/canary cohort:
- Health and alert signal:
- Rollback condition:
