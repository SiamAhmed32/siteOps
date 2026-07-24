# AI Usage

How AI was used on this assessment.

## Tools

- **Cursor** (chat / agent) — primary implementation tool: scaffolding, first drafts of the claims
  module, and aligning new code with the starter's patterns (especially dockets).
- **Kimi K3 (Moonshot AI)** — Used for initial reading comprehension and requirements extraction. I pasted the starter README and assessment brief; Kimi reformatted both into structured summaries and highlighted the normative glossary terms, golden-path math examples, and open design questions. This saved ~15 minutes of manual parsing but did not produce any code, tests, or architectural decisions. I rejected none of its output, but it did not attempt any implementation — all design choices (levy snapshotting, two-key concurrency, rejected-claim policy) remain mine to make.

- **Codex** (OpenAI coding agent) — used as a second agent for review passes: a sanity check on
  whether I was on the right track, not to run my tests for me.
  

## What AI was used for

Most of the heavy implementation came from AI first drafts, which I then read, corrected, and
integrated:

- Claim totals calculator (`decimal.js`, levy computed once on the fuel subtotal, half-up) and the
  first cut of its unit tests, including the golden examples `$67.47` / `$7.25`.
- Claims service paths — create / submit / approve / reject / list / import: reference sequencing,
  audit, transactional outbox, and the race-safe `updateMany` transitions for the two-key flow.
- Prisma schema + migration drafts: Decimal money columns, the levy snapshot fields
  (`levyRatePercent` / `levyAmount`), and the two-key / rejection columns.
- Controller + permission decorators mirroring dockets; the `GET /claims/effective-rate` endpoint;
  the LegacyPlant CSV import service and parser scaffold.
- Frontend screens: claims list (React Query + pagination + status/FY filters), new-claim form
  (RHF + zod + `useFieldArray` + live `decimal.js` preview), claim detail (actions, audit timeline,
  GST/inc-GST reference, two-key callout), and the CSV import screen.
- Backend-hardening drafts: wiring the global exception filter, tightening the create DTO,
  curating import error messages, strict CSV date parsing, and the shared money/quantity/total
  overflow bounds shared by create + import.

## What I wrote / owned by hand

- **Tests & test runs** — set up PostgreSQL via Docker, ran the full Jest suite (pure unit +
  Postgres workflow/concurrency + HTTP/Supertest), and fixed the failures the AI drafts produced
  until green. I decided *what* earned a test: concurrency winners at both keys, cross-org isolation,
  the success/error envelope, and best-effort import.
- **Manual verification** — `prisma migrate` / `db seed` / `prisma generate`, UI smoke checks, and
  DevTools/network checks that the envelope and React Query cache invalidation actually behaved.
- **Debugging & error-solving** — chased down the concrete bugs in the section below; most AI drafts
  needed a correction pass before they were right.
- **Smaller pieces I wrote myself** — not whole modules, but the load-bearing helpers and rules
  the drafts kept getting wrong or leaving soft:
  - `financialYearFromDate` / `financialYearCode` / `claimSequenceKey` / `financialYearDateRange`
    in `financial-year.ts` — AU FY from the expense date only (1 Jul–30 Jun), the two-digit code
    used in `EXP {FY}-{seq}`, and the half-open date range the list FY filter queries against.
  - `requiresTwoKeys` in `claim-lifecycle.ts` — threshold check on a decimal string / `Decimal`
    (`>` $1,000.00; exactly $1,000.00 is one key), never a bare JS number.
  - LegacyPlant date/price helpers I locked down by hand: `isStrictIsoDate` (rejects `2026-02-30`
    and `02/10/2026`), and the `"1,299.50"` / `$…` normalisation used by import.
  - Create-DTO hardening on `ClaimLineDto` / `CreateClaimDto`: trimmed descriptions (`@Length(1,200)`),
    quantity `@Min(1)` / `@Max(1_000_000)`, `unitPrice` as a decimal string matching the money regex,
    and `@ArrayMaxSize(500)` on lines.
  - The new-claim zod schema (`lineSchema` / `claimSchema`) — same bounds on the client so the
    form fails closed before the request leaves the browser.    
  - The fake-auth guard that rejects when `user.orgId !== x-org-id`, and removing the unused
    starter `web/lib/api.ts` once the real client lived under `web/lib/api/client.ts`.
- **UI/UX direction** — I drove the front-end usability work. The clearest example is the CSV
  import screen — I flagged that the raw textarea was hard to read (you couldn't tell which
  comma-separated value belonged to which column), that the format guide left dead space on the
  right, and that a duplicate-reference collision showed a message that didn't say what was wrong.
  I set the direction; the AI implemented to that spec: a live grouped preview (one block per claim,
  invalid cells with hover reasons, same-date-per-group), full-width preview + sticky guide, and a
  clear `A claim with reference … already exists.` conflict. An early line-number gutter idea was
  dropped on my call — physical editor lines drifted from the server's non-empty-line row numbers
  once a blank line existed.
- **Design decisions** — levy snapshotting for reproducibility, the two-key concurrency model,
  the rejected-claim policy (final; fix = lodge a new claim), and the money/rounding approach
  (all in `DECISIONS.md`).

## What AI got wrong (and how I caught it)

- First calculator used JS `number * 100` for cents — too weak for "exact to the cent". I switched it
  to `decimal.js` with string inputs; it now returns `Decimal`, never a JS number.
- An early `claim_money_decimal` migration **deleted all `Claim` / `ClaimLine` rows** to add the
  `NOT NULL` levy columns. I caught this reviewing the SQL and rejected it; the committed migration
  alters in place, backfills from the effective-dated rate + fuel lines, then sets `NOT NULL` — no
  `DELETE`. I verified it on disposable databases (old-data backfill, and a claim predating any rate
  fails the migration loudly instead of fabricating one).
- A later draft **invented a `levyRatePercent = 12.50` fallback** and never recomputed `Claim.total`.
  I corrected it to backfill only from effective-dated rates and to recompute `total` from lines + levy.
- The starter `GlobalExceptionFilter` was never wired up, so errors could bypass the platform
  envelope. I registered it globally and added HTTP tests asserting the `{ success, error }` shape.
- The live total preview stayed at `—` because `watch()` + `useMemo` didn't re-run when RHF updated
  nested line fields in place. Fixed with `useWatch` on `expenseDate` and `lines`.
- The preview also hard-coded the levy schedule on the client (it would drift from the DB if a rate
  row changed) and silently dropped incomplete lines from the total. I added `GET /claims/effective-rate`
  so the client reads the same rate the server applies, and made the preview show `—` whenever any
  current line is invalid.
- The first CSV import screen was a plain textarea, so it wasn't obvious which comma-separated value
  mapped to which column, the short format guide stranded empty space on the right, and a duplicate
  claim reference surfaced only a vague "record already exists" / "failed to create claim". From my
  UX review I directed the redesign that shipped: grouped claim blocks in the preview (not a flat
  table that lied about non-contiguous groups), same-date-per-group validation, sticky format guide,
  and the specific reference-collision message. I also had the P2002 handler narrowed so it only
  claims a reference collision when `meta.target` includes `reference`.

## Remaining scope

- Mandatory backend + frontend are complete, and the optional CSV **import UI** (`/claims/import`)
  was also built on top of the tested `POST /claims/import` endpoint. The only deliberate cut is the
  multiline quoted-CSV case noted in `DECISIONS.md` — LegacyPlant exports are one physical line per
  row, so a full CSV library wasn't warranted.
