# AI Usage

log of how AI was used on this assessment. Specific beats impressive.

## Tools

- **Cursor** (chat / agent) for scaffolding, debugging, and aligning with starter patterns (especially dockets).
- **Kimi** (via Cursor) for implementation assistance on claims workflow slices.

Complex platform wiring and first drafts of calculator / create / submit / approve / import came from AI tools; smaller pure helpers, validation rules, docs ownership, and all verification runs were mine. Ownership claims below are meant to be literally accurate for finished files I personally wrote or heavily edited.

## What AI was used for

- First draft of the claim totals calculator and most unit tests (including golden examples `$67.47` / `$7.25`).
- Rework toward `decimal.js` + `ROUND_HALF_UP` after float-precision and review feedback.
- Claim create / submit / approve / reject / list / import service paths (sequence, audit, outbox, `updateMany` races).
- Schema/migration drafts for Decimal columns + levy snapshot + approval fields.
- Controller permissions wiring (mirroring dockets).
- Draft PostgreSQL workflow test cases (I run and fix failures locally).
- Draft of the HTTP (Nest + Supertest) e2e suite for envelope / guard / middleware coverage.
- Backend-hardening pass after external review: register the global exception filter, tighten create-DTO validation, curate import error messages, and strict CSV date parsing.
- Second hardening pass: shared money/quantity/total overflow bounds in the calculator (so create + import both return `400`/curated instead of a Prisma overflow `500`).

## What I wrote / owned by hand

- **`api/src/claims/financial-year.ts`** + **`financial-year.spec.ts`** (incl. FY date-range filter helper)
- **`api/src/claims/claim-lifecycle.ts`** + **`claim-lifecycle.spec.ts`**
- **`api/src/claims/legacy-plant-csv.ts`** + **`legacy-plant-csv.spec.ts`** (CSV parse / price normalize)
- **`api/src/claims/dto/*`** — create / list / import DTOs
- **`api/src/claims/claims.controller.ts`** — routes + permission decorators (`import` before `:id`)
- **`api/src/auth/fake-auth.middleware.ts`** — `user.orgId === x-org-id` check
- DTO hardening: trimmed/bounded descriptions, non-negative bounded `unitPrice`, quantity/line caps
- `isStrictIsoDate` CSV date validation + its tests
- Small web fixes for string/`Number(total)` money display
- **`DECISIONS.md`** / **`AI-USAGE.md`**
- Caught and required correction of the destructive money migration draft (see below)
- Ran the **migration upgrade-path verification** on disposable Postgres databases (old-data backfill + missing-rate failure)
- All test runs, migrate/seed/`prisma generate`, and manual smoke checks

## What AI got wrong (and how it was caught)

- First calculator used JS `number * 100` for cents — too weak for “exact to the cent”; replaced with `decimal.js` + string inputs; calculator now returns **`Decimal`**, not JS numbers.
- An early `claim_money_decimal` migration draft **deleted all `Claim` / `ClaimLine` rows** to add `NOT NULL` levy columns. Rejected in review; committed migration **alters in place, backfills from effective rates + fuel lines, then sets NOT NULL** — no `DELETE`.
- Docs briefly claimed the wipe was fixed while an older DELETE SQL was still being discussed in review — migration file and DECISIONS/AI-USAGE were aligned to the backfill SQL before push.
- A later migration draft **invented a `levyRatePercent = 12.50` fallback** and never recomputed `Claim.total`. Review flagged both; corrected to backfill only from effective-dated rates (failing loudly otherwise) and to recompute `total` from lines + levy.
- The starter `GlobalExceptionFilter` was never wired up, so errors could bypass the platform envelope. Registered it globally and added HTTP tests asserting the `{ success, error }` shape.

## Still to fill as work continues

- Claims frontend (list filters, detail, RHF+zod, React Query) — backend minimum endpoints are in place.
- README update near submission.
