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

- `EXP {FY}-{seq}` via `financialYearCode` + `SequenceService` key `claim:{FY}` per org. `SequenceService` claims each value with an atomic PostgreSQL `UPDATE ... RETURNING` inside the same transaction that creates the claim; `(orgId, key)` and `(orgId, reference)` unique constraints provide database-level protection against duplicates.

## Levy reproducibility

- Persist rate/amount/total at create; submit does not re-read live `SurchargeRate`.

## Effective-rate lookup

- `GET /claims/effective-rate?date=` returns the effective-dated `SurchargeRate` in force on a date (or `ratePercent: null` when none applies yet). Create and this endpoint share one private `lookupLevyRate` helper, so the new-claim preview and the persisted total resolve the rate identically — the client never hard-codes the rate schedule.

## Lodgment

- Submitter-only; `updateMany` with `DRAFT` + `submitterId` in WHERE.

## Concurrent decisions / two-key

- Total **> $1000** → two keys; **$1000.00** exact → one key.
- Each decision uses a conditional `updateMany` containing the expected current status; the second key also checks the first approver. Only one competing update can succeed, while its audit and final outbox writes remain in the same transaction. No self-dealing; covered by Postgres concurrency tests.

## Final-approval event

- Final `APPROVED` only: audit + outbox `claim.approved` in the same transaction.

## Rejected claims

- `REJECTED` is final; fix by creating a **new** claim (preserves rejected audit history).
- Reject is a **single-reviewer** decision from `SUBMITTED` or `PARTIALLY_APPROVED` — any approver except the submitter can reject, **including the first-key holder**. Deliberate: two-key is dual control on *spending* (approval), not on *stopping* a claim; a reviewer who turned key one must still be able to kill it if they spot a problem before the second key arrives. Self-dealing (submitter) is the only block on reject.

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
- **New claim (`/claims/new`)** — react-hook-form + zod; `useFieldArray` for lines; live ex-GST preview via `decimal.js` using the **same levy algorithm** as the API (fuel subtotal → levy once, half-up). The effective rate for the preview is **fetched from the API** (`GET /claims/effective-rate?date=`), which runs the *same* effective-dated `SurchargeRate` lookup the create path uses — so the preview can't drift from the server if a rate row changes (an earlier version hard-coded the seeded schedule client-side; replaced to guarantee parity). `useWatch` drives the preview (not `watch`+`useMemo`, which missed in-place field updates). The preview shows **`—` whenever any current line is invalid/incomplete** (it does not silently drop bad lines and total the rest, which would mislead). On create success, invalidates `queryKeys.claims` so the list refreshes without a full reload.
- **Detail (`/claims/[id]`)** — line items, ex-GST totals with fuel/levy breakdown, GST + inc-GST **reference only** (not stored/thresholded). Audit timeline from `GET /claims/:id` history. Submit (submitter + `DRAFT` only), Approve/Reject (`claims.approve`, no self-dealing). Two-key callout when total > $1,000: shows first approver on `PARTIALLY_APPROVED` and disables second key for the same user. Mutations invalidate claims list, detail, and burn report.
- **Import (`/claims/import`)** — optional stretch screen for file upload/paste, project selection, grouped preview, and created/failed results from `POST /claims/import`. The preview mirrors the server's grouping, field, date, and row-number rules and has focused Vitest coverage, but remains an affordance: the API is the source of truth. UI permission checks are present for usability; the API enforces access.
- UI permission gates (`useActingUser().can`) are affordances only — the API guard/middleware enforce the real rules.
- Removed Priya's unused `web/lib/api.ts` fetch helper once all claims screens moved to the envelope-aware `lib/api/client.ts`.

## Deliberately skipped

- CSV parser assumes **one physical line per row**; multiline quoted fields / unterminated-quote recovery are unsupported (LegacyPlant exports are single-line; the brief emphasises quoted *prices*, which are handled). A mature CSV library would be the next step if multiline fields appear.
- No UI theming / real auth / new CRUD — per the brief's "what we do NOT want".
