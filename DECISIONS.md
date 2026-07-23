# Decisions

Short, bullet-style notes for the SiteOps expense-claims assessment.

## Money / rounding

- Use **`decimal.js`** for claim money math (explicit dependency; same library Prisma Decimal is built on). Prefer decimal **strings** on the wire.
- Line total = `quantity × unitPrice` with **quantity a positive integer**.
- Levy = half-up to the cent of **`(fuel subtotal × ratePercent / 100)` once** — never sum of per-line levies.
- Unit prices: at most **2** decimal places (`parseMoney`). Levy **rates** use a separate parser (`parseRatePercent`, up to 4 dp input) — rates are not money cents.
- Calculator returns **`Decimal` values** (not JS `number`) through to persistence (`toFixed(2)` strings into Prisma Decimal columns).

## Schema changes

- `Claim.total`, `Claim.levyAmount`, `ClaimLine.unitPrice`, `SurchargeRate.ratePercent` → `Decimal` (no Float money).
- Added `Claim.levyRatePercent` + `Claim.levyAmount` so totals stay reproducible when org rates change later.
- Added `firstApprovedById` / `firstApprovedAt` / `rejectedById` / `rejectedAt` for two-key and reject tracking.
- Claim reference uniqueness is `@@unique([orgId, reference])` (same idea as dockets).
- Create stores the rate in force on `expenseDate`; submit does not re-read live rates.
- Money migration (`claim_money_decimal`) **alters in place and backfills** levy fields — it must not `DELETE` claims. (An earlier AI draft that wiped claim tables was rejected; the committed SQL is the backfill version.)

## Reference numbering

- Format `EXP {FY}-{seq}` with FY from expense date (AU FY: Jul–Jun) via `financialYearCode`.
- Seq from `SequenceService` with key `claim:{FY}` per org — collision-free under concurrency; gaps OK.

## Levy reproducibility

- On create, persist `levyRatePercent` + `levyAmount` + `total` from the rate effective on `expenseDate`.
- Lodgment (`POST /claims/:id/submit`) only flips `DRAFT → SUBMITTED` — it does **not** re-query `SurchargeRate` or recompute totals.

## Lodgment

- Only the claim's `submitterId` may submit; others get `403`.
- Atomic `updateMany` with `status: DRAFT` + `submitterId` in the WHERE (same idea as docket confirm) so double-submit races yield one winner + `409`.

## Concurrent decisions / two-key

- Threshold: ex-GST total **> $1,000.00** needs two keys; **$1,000.00 exactly** is one key (`requiresTwoKeys` — Decimal/string only, no JS `number`).
- First key on SUBMITTED → `PARTIALLY_APPROVED` + `firstApprovedById`; second key must be a **different** user → `APPROVED`.
- One-key path: SUBMITTED → `APPROVED` in a single step.
- Race safety: `updateMany` with expected `status` (and `firstApprovedById: { not: actor }` for second key) in the WHERE.
- No self-dealing on approve or reject (`submitterId === actor` → 403).
- Covered by PostgreSQL workflow tests (`claims.workflow.spec.ts`), including concurrent first/second keys and approve-vs-reject.

## Final-approval event

- On final `APPROVED` only: audit `claim.approved` + outbox `claim.approved` (payload: claimId, reference, total, projectId) inside the same transaction.
- First-key / partial approval does **not** enqueue outbox.

## Rejected claims

- Reject allowed from `SUBMITTED` or `PARTIALLY_APPROVED` → `REJECTED` (final).
- Supervisor fixes by creating a **new** claim — we do not reopen REJECTED in this slice (keeps decisions final and preserves the rejected claim’s audit history).

## Deliberately skipped (for now)

- CSV **import UI** (API still required — not built yet).
- Claims list pagination / status+FY filters (next).
- Full claims frontend (React Query, RHF+zod, detail page with GST reference + two-key UI) — next.
- Fake-auth org/user consistency check (`user.orgId === x-org-id`) — before final submission.
- README polish — near submission.
