# Decisions

Short, bullet-style notes for the SiteOps expense-claims assessment.

## Money / rounding

- Use **`decimal.js`** for claim money math (explicit dependency; same library Prisma Decimal is built on). Prefer decimal **strings** on the wire.
- Line total = `quantity × unitPrice` with **quantity a positive integer**.
- Levy = half-up to the cent of **`(fuel subtotal × ratePercent / 100)` once** — never sum of per-line levies.
- Unit prices: at most **2** decimal places (`parseMoney`). Levy **rates** use a separate parser (`parseRatePercent`).
- Calculator returns **`Decimal` values** through to persistence (`toFixed(2)` strings into Prisma Decimal columns).

## Schema changes

- Claim / line / surcharge money columns → `Decimal` (no Float).
- `levyRatePercent` + `levyAmount` on create for reproducibility; `firstApprovedBy*` / `rejectedBy*` for workflow.
- `@@unique([orgId, reference])` like dockets.
- Money migration alters in place and **backfills** — no claim `DELETE` in the committed SQL. It backfills `levyRatePercent` from the **effective-dated** `SurchargeRate` (no invented fallback rate), then `levyAmount`, then **recomputes `total`** (line subtotal + levy) so any legacy/broken totals are corrected. A claim with no matching rate is left `NULL` so the `SET NOT NULL` step fails loudly rather than fabricating data. On a fresh install these backfills touch 0 rows (seed runs after migrate); they exist as a real remediation path for pre-existing data.

## Reference numbering

- `EXP {FY}-{seq}` via `financialYearCode` + `SequenceService` key `claim:{FY}` per org.

## Levy reproducibility

- Persist rate/amount/total at create; submit does not re-read live `SurchargeRate`.

## Lodgment

- Submitter-only; `updateMany` with `DRAFT` + `submitterId` in WHERE.

## Concurrent decisions / two-key

- Total **> $1000** → two keys; **$1000.00** exact → one key.
- Race-safe `updateMany`; no self-dealing; covered by Postgres workflow tests.

## Final-approval event

- Final `APPROVED` only: audit + outbox `claim.approved` in the same transaction.

## Rejected claims

- `REJECTED` is final; fix by creating a **new** claim (preserves rejected audit history).

## List + import

- `GET /claims` paginated; filters `status` and two-digit `fy` (expense-date FY range).
- `POST /claims/import` — LegacyPlant CSV (`expense_date,description,quantity,unit_price,is_fuel,group`) plus `projectId` in the body (export has no cost code). Best-effort per `group`; any bad line rejects that group whole. Prices like `"1,299.50"` normalized. Creates **DRAFT** claims for the acting user.

## Fake auth

- Middleware requires `user.orgId === x-org-id` (tenant consistency; still not real auth).

## Error envelope / input hardening

- `GlobalExceptionFilter` registered globally in `main.ts`; every error leaves as `{ success:false, error:{ code, message }, timestamp }`. `ValidationPipe` uses `whitelist` + `forbidNonWhitelisted`.
- Create DTO: descriptions **trimmed** + length-bounded; `unitPrice` a **non-negative** decimal (≤ 2 dp, ≤ `Decimal(12,2)` capacity) so a bad price is a clean `400`, not a `500`; quantity/line-count capped.
- **Storage bounds are shared, not DTO-only.** `computeClaimTotals`/`parseMoney` enforce `MAX_MONEY = 9,999,999,999.99`, `MAX_QUANTITY = 1,000,000`, and reject an aggregate `total` that would overflow `Decimal(12,2)`. Since **both** HTTP create and CSV import run through the calculator, an oversized claim is a `400` (create wraps calculator errors) or a curated per-group failure (import) — never a Prisma overflow `500`. The CSV parser mirrors the same limits so bad rows get clear reasons before reaching the DB.
- CSV `expense_date` must be a **real `YYYY-MM-DD`** date (rejects `2026-02-30`, `2026-13-01`, `02/10/2026`) — `Date.parse` was too lenient.
- Import failures surface only **curated** business messages; Prisma/internal errors return a generic message (no leaks).

## Migration upgrade-path (verified)

- The money migration was hand-edited after it had already applied locally, so `migrate status` alone doesn't prove the backfill. Verified on **disposable databases**: apply init → insert old Float claims → apply money + approval migrations. Confirmed no rows lost, effective-dated rate chosen correctly (10% for a 2025 claim, 12.5% for a 2026 claim), levy + `total` recomputed (a deliberately-wrong legacy total was corrected to the golden `$67.47`), and a claim predating any rate **aborts** the migration (`levyRatePercent contains null values`) rather than fabricating a rate.

## Testing

- Pure unit tests (money, FY, lifecycle, CSV) + **Postgres** service tests (workflow/concurrency, list, import) + a focused **HTTP** suite (`claims.http.spec.ts`, Nest + Supertest, real Postgres) covering middleware, ValidationPipe, PermissionsGuard, and the success/error envelope.

## Deliberately skipped

- CSV parser assumes **one physical line per row**; multiline quoted fields / unterminated-quote recovery are unsupported (LegacyPlant exports are single-line; the brief emphasises quoted *prices*, which are handled). A mature CSV library would be the next step if multiline fields appear.
- CSV **import UI** (optional stretch) — API is implemented; UI left out on purpose.
- Full claims **frontend** (React Query list/filters, RHF+zod form, detail with GST/two-key UI) — next slice after backend.
- README polish — near submission.
