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

## Frontend (claims)

- **List (`/claims`)** — React Query + pagination; filters by `status` and FY (options generated from today's date: current FY + 3 back, so FY27 claims are filterable). Rows link to detail. Mirrors dockets list patterns (`queryKeys`, `apiGet`, `keepPreviousData`).
- **New claim (`/claims/new`)** — react-hook-form + zod; `useFieldArray` for lines; live ex-GST preview via `decimal.js` using the **same levy algorithm** as the API (fuel subtotal → levy once, half-up). Effective rate for preview comes from the **seeded rate schedule** (10% from 2024-07-01, 12.5% from 2026-01-01) — no surcharge CRUD in scope, so the client mirrors seed data rather than calling a rates API. `useWatch` drives the preview (not `watch`+`useMemo`, which missed in-place field updates). On create success, invalidates `queryKeys.claims` so the list refreshes without a full reload.
- **Detail (`/claims/[id]`)** — line items, ex-GST totals with fuel/levy breakdown, GST + inc-GST **reference only** (not stored/thresholded). Audit timeline from `GET /claims/:id` history. Submit (submitter + `DRAFT` only), Approve/Reject (`claims.approve`, no self-dealing). Two-key callout when total > $1,000: shows first approver on `PARTIALLY_APPROVED` and disables second key for the same user. Mutations invalidate claims list, detail, and burn report.
- UI permission gates (`useActingUser().can`) are affordances only — the API guard/middleware enforce the real rules.
- Removed Priya's unused `web/lib/api.ts` fetch helper once all claims screens moved to the envelope-aware `lib/api/client.ts`.

## Deliberately skipped

- CSV parser assumes **one physical line per row**; multiline quoted fields / unterminated-quote recovery are unsupported (LegacyPlant exports are single-line; the brief emphasises quoted *prices*, which are handled). A mature CSV library would be the next step if multiline fields appear.
- CSV **import UI** (optional stretch) — the brief marks it optional and the `POST /claims/import` API is fully implemented and tested; a screen would add form/upload plumbing without demonstrating new judgment. Next step if built: textarea/file upload posting to the import endpoint, rendering per-group created/failed results.
- No UI theming / real auth / new CRUD — per the brief's "what we do NOT want".
