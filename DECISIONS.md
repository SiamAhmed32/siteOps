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

- `Claim.total`, `Claim.levyAmount`, `ClaimLine.unitPrice`, `SurchargeRate.ratePercent` → `Decimal` (no Float money).
- Added `Claim.levyRatePercent` + `Claim.levyAmount` so totals stay reproducible when org rates change later.
- Claim reference uniqueness is `@@unique([orgId, reference])` (same idea as dockets) so two orgs can both have `EXP 26-0001`.
- Create always stores the rate in force on `expenseDate`; submit must not re-read live rates (enforced when submit lands).

## Reference numbering

- Format `EXP {FY}-{seq}` with FY from expense date (AU FY: Jul–Jun) via `financialYearCode`.
- Seq from `SequenceService` with key `claim:{FY}` per org — collision-free under concurrency; gaps OK.

## Levy reproducibility

- On create, persist `levyRatePercent` + `levyAmount` + `total` from the rate effective on `expenseDate`.
- Lodgment (submit) must use the stored rate/amounts — never re-query `SurchargeRate` for an already-computed claim (submit endpoint will enforce this).

## Concurrent decisions / two-key

- (TBD)

## Final-approval event

- (TBD)

## Rejected claims

- (TBD)

## Deliberately skipped

- (TBD)
