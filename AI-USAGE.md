# AI Usage

log of how AI was used on this assessment. Specific beats impressive.

## Tools

- **Cursor** (chat / agent) for scaffolding, debugging, and aligning with starter patterns (especially dockets).
- **Kimi** (via Cursor) for implementation assistance on claims workflow slices.

Complex platform wiring and first drafts of calculator / create / submit / approve came from AI tools; smaller pure helpers, validation rules, docs ownership, and all verification runs were mine. Ownership claims below are meant to be literally accurate for finished files I personally wrote or heavily edited.

## What AI was used for

- First draft of the claim totals calculator and most unit tests (including golden examples `$67.47` / `$7.25`).
- Rework toward `decimal.js` + `ROUND_HALF_UP` after float-precision and review feedback.
- Claim create / submit / approve / reject service paths (sequence, audit, outbox, `updateMany` races).
- Schema/migration drafts for Decimal columns + levy snapshot + approval fields.
- Controller permissions wiring (mirroring dockets).
- Draft PostgreSQL workflow test cases (I run and fix failures locally).

## What I wrote / owned by hand

- **`api/src/claims/financial-year.ts`** + **`financial-year.spec.ts`**
- **`api/src/claims/claim-lifecycle.ts`** + **`claim-lifecycle.spec.ts`** (threshold helper; Decimal/string only)
- **`api/src/claims/dto/create-claim.dto.ts`** — validation; no client `status`
- **`api/src/claims/claims.controller.ts`** — route + permission decorators
- Small web fixes for string/`Number(total)` money display
- **`DECISIONS.md`** / **`AI-USAGE.md`** — design and disclosure (including incorporating Codex review points)
- Caught and required correction of the destructive money migration draft (see below)
- All test runs, migrate/seed/`prisma generate`, and manual smoke checks

## What AI got wrong (and how it was caught)

- First calculator used JS `number * 100` for cents — too weak for “exact to the cent”; replaced with `decimal.js` + string inputs; calculator now returns **`Decimal`**, not JS numbers.
- An early `claim_money_decimal` migration draft **deleted all `Claim` / `ClaimLine` rows** to add `NOT NULL` levy columns. Rejected in review; committed migration **alters in place, backfills from effective rates + fuel lines, then sets NOT NULL** — no `DELETE`. (Local DB that already ran a wipe needs re-seed; the SQL in git is the non-destructive version.)
- Docs briefly claimed the wipe was fixed while an older DELETE SQL was still being discussed in review — migration file and DECISIONS/AI-USAGE were aligned to the backfill SQL before push.

## Still to fill as work continues

- CSV import API; claims frontend (list filters, detail, RHF+zod, React Query).
