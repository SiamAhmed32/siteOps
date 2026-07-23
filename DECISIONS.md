# Decisions

Short, bullet-style notes for the SiteOps expense-claims assessment.

## Money / rounding

- Use **Prisma `Decimal`** (decimal.js) for all claim money math — same family as equipment `hireRatePerDay`.
- Prefer **decimal strings** on the wire and into the calculator (e.g. `"19.99"`), so values are not parsed from IEEE-754 floats.
- Line total = `quantity × unitPrice` with **quantity a positive integer** (matches `ClaimLine.quantity Int` in the starter schema).
- Levy = half-up to the cent of **`(fuel subtotal × ratePercent / 100)` once** — never sum of per-line levies.
- Unit prices must have **at most 2 decimal places**; reject finer precision at parse time.
- Calculator returns numbers already quantized to 2 dp via `ROUND_HALF_UP` for JSON responses.

## Schema changes

- (TBD — Decimal columns for claim money; snapshot levy rate/amount at lodgment)

## Reference numbering

- (TBD — `SequenceService` + expense-date FY)

## Levy reproducibility

- (TBD — snapshot rate on submit)

## Concurrent decisions / two-key

- (TBD)

## Final-approval event

- (TBD)

## Rejected claims

- (TBD)

## Deliberately skipped

- (TBD)
