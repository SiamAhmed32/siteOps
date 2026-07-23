# AI Usage

log of how AI was used on this assessment. Specific beats impressive.

## Tools

- Cursor, kimi k3 (chat / agent) for scaffolding, debugging, and review against the starter patterns (especially dockets).

## Division of work (so far)

Complex platform wiring and the first calculator draft came from AI; smaller pure helpers, validation rules, docs, and all verification were mine.

## What AI was used for 

- First draft of the claim totals calculator and most unit tests (including golden examples `$67.47` / `$7.25`).
- Rework toward Prisma `Decimal` + `ROUND_HALF_UP` after float-precision review.
- Claim create service path: effective levy lookup, transaction, `SequenceService` integration, audit recording.
- Schema/migration draft for Decimal columns + levy snapshot fields.
- Controller permissions guard wiring (mirroring dockets).

## What I wrote / owned by hand

Finished work I take as mine (simple, deliberate pieces):

- **`api/src/claims/financial-year.ts`** — AU FY helpers (`financialYearFromDate`, `financialYearCode`, `claimSequenceKey`) and the matching **`financial-year.spec.ts`** cases.
- **`api/src/claims/dto/create-claim.dto.ts`** — validation rules: positive `@IsInt` quantity, `@IsDecimal` string prices, `@ArrayMinSize(1)`, description length, and **removing client `status`** so create is always DRAFT.
- **`web/app/claims/new/page.tsx`** — send `unitPrice` as a decimal string and `quantity` via `parseInt` (not `parseFloat`).
- **`web/app/claims/page.tsx`** — `Number(c.total).toFixed(2)` so Decimal JSON strings render.
- **`DECISIONS.md`** — money / schema / FY reference / reproducibility bullets (my design calls).
- **`AI-USAGE.md`** — this log.

Also mine end-to-end: running tests, migrate/seed/`prisma generate`, updating `.env.local`, and manually verifying create (DRAFT, totals, reference).

## What AI got wrong (and how it was caught)

- First calculator used JS `number * 100` for cents — too weak for “exact to the cent”; caught in review and replaced with `Decimal` + string inputs.
- Priya-style create (calendar year, `count + 1`, blanket 12.5% on all lines) was rejected in favour of dockets patterns and the glossary levy rules.

## Still to fill as work continues

- Submit / approve / reject / import — keep the same split (AI on complex workflow; I keep small helpers, DTO tweaks, docs, and all test runs).
- Frontend React Query claims screens.
- Integration tests against real Postgres.
- Any AI suggestions I reject on lifecycle, two-key, or race safety.
