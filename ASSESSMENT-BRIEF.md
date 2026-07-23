# SiteOps — Expense Claims Workflow

## Mid-Level Fullstack Engineer — Take-Home Assessment

**Scope:** we'd rather see a smaller slice done properly than everything done shallowly. If you decide not to build something, cut scope deliberately and write down what you'd do next in `DECISIONS.md`.

**AI tools:** permitted and expected — we use them daily. Include an `AI-USAGE.md` describing what you used AI for, where it helped, and where you had to correct or reject its output. We assess *how well* you drive these tools, not whether you avoided them. Submissions without a credible `AI-USAGE.md` are assumed to be 100% hand-written and will be interviewed accordingly.

**Deliverable:** your fork/copy of the starter repository (with meaningful commit history — don't squash to one commit) plus an updated `README.md`, `DECISIONS.md`, and `AI-USAGE.md`.

---

## The story so far

**SiteOps** is the operations platform we build for Australian road-works contractors. Our anchor customer is **RoadCo Contracting** — pavers, rollers, and traffic crews spread across motorway jobs, most of the work done at night, most of the paperwork historically done in a shared drive the crews call *"the Folder."*

Over the last two quarters the platform team replaced most of the Folder: **projects** carry the cost codes, **plant dockets** track equipment hours (site leads confirm them each morning), **site notes** hang off any record, and the office watches **burn** on the dashboard. The last stronghold of the Folder is **expense claims** — supervisors buying diesel, paint, and timber on company cards, photographing receipts, and emailing spreadsheets to Norma in accounts. Norma is retiring in August. The Folder retires with her.

The engineer who started the claims module, **Priya**, was pulled onto another delivery mid-sprint. Her create/read path is in the repo, her name is on the commits, and her parting words in standup were *"it runs, but I hadn't done the hardening pass — check it against how dockets does things."* It's your module now.

Below is the workflow spec, written with our ops leads. The glossary terms are load-bearing — when the spec says *the levy* or *the two-key rule*, those definitions are the requirement. Read them the way a site lead would: literally.

## Glossary (normative)

| Term | Meaning |
|---|---|
| **FY** | Financial year, **1 July – 30 June**. FY26 ends 30 June 2026. A claim's FY comes from its **expense date**, nothing else. |
| **The levy** | The site fuel levy — a surcharge applied to **fuel line items only**, computed **once on the fuel subtotal** of a claim, then rounded to the cent, half-up. The levy rate is **effective-dated** per org (seeded: 10% from 1 Jul 2024, 12.5% from 1 Jan 2026); a claim uses the rate in force **on its expense date**. |
| **Ex-GST** | Every amount entered, stored, and compared in SiteOps is **exclusive of GST**. The UI may show GST (10%) and inc-GST figures *for reference*, but nothing is ever stored or thresholded inc-GST. |
| **The two-key rule** | Any claim whose **ex-GST total exceeds $1,000.00** needs **two different approvers** — first approval parks it at `PARTIALLY_APPROVED`, a second, different approver finishes it. $1,000.00 exactly is one key. |
| **No self-dealing** | Nobody acts on their own claim: submitters can't approve or reject what they lodged — not even as the second key. |
| **Lodgment** | A supervisor submitting their draft claim for review. Only the claim's own submitter can lodge it. |
| **Cost code** | The project a claim or docket bills against. Every claim belongs to exactly one project **of the same org**. |
| **Burn** | Committed spend per project: approved claims + confirmed dockets, ex-GST. The dashboard already computes it — approved claims flow into it the moment your workflow approves them. |
| **The LegacyPlant export** | CSV files from RoadCo's old plant system, used to bulk-load claims. Prices arrive formatted like `"1,299.50"`. Norma's team will keep producing these until every depot is migrated. |

## What to build

The starter runs end to end (see `README.md`): kernel under `api/src/common/`, audit + outbox + sequence services, working **Projects / Equipment / Dockets / Notes / Reports** modules, and a web app with dashboard, projects, equipment, and dockets screens. The **claims** module has Priya's create/read path and two rough screens. Finish the feature:

### Backend — the claims workflow

1. **References** — claims are numbered `EXP {FY}-{seq}`, e.g. `EXP 26-0042`: two-digit FY, then a per-org, per-FY sequence. References never collide, whatever is happening concurrently.
2. **Totals** — computed server-side from line items, ex-GST, exact to the cent. Each line total = quantity × unit price. Then the levy (see glossary). **Golden examples that must hold exactly** (at the 12.5% levy rate): one fuel line of 3 × $19.99 → total **$67.47**; two fuel lines of 1 × $1.00 each plus one non-fuel line of 1 × $5.00 → total **$7.25**.
3. **Reproducibility** — changing levy rates later must never change the total of an already-lodged claim. How you guarantee that is your design decision; explain it in `DECISIONS.md`.
4. **Lifecycle** — `DRAFT → SUBMITTED → APPROVED | REJECTED`, with `PARTIALLY_APPROVED` under the two-key rule. Lodgment, no self-dealing, and the `claims.approve` permission are enforced as the glossary defines them. Invalid transitions are rejected with a clear error.
5. **Decisions are final and race-safe** — design for two reviewers acting on the same claim at the same instant, at every step of the two-key flow.
6. **Bulk import** — `POST /claims/import` accepts a LegacyPlant export: columns `expense_date, description, quantity, unit_price, is_fuel, group`; rows sharing a `group` form one claim. Import is **best-effort per claim**: valid claims are created, invalid ones are reported back with row numbers and reasons in one response. A partially-valid claim (one bad line) is rejected whole.
7. **Audit + aftermath** — every state-changing action lands in the audit trail, and final approval produces the event that the rest of the platform (ledger, notifications — not your problem) will consume. The starter shows how the platform does both.
8. **Endpoints (minimum)** — `POST /claims`, `GET /claims` (paginated; filterable by status and FY), `GET /claims/:id` (with decision/audit history), `POST /claims/:id/submit`, `/approve`, `/reject`, `POST /claims/import`. Responses use the platform envelope; errors never leak internals.

One of the ops leads mentioned in passing that rejected claims *"usually come back around after the supervisor fixes them."* The spec above is all you get in writing — resolve this how you see fit and document your reasoning in `DECISIONS.md`.

### Frontend — finish the claims screens

The shell, dashboard, projects, equipment, and dockets screens are done. Bring claims up to the same standard:

1. **Claims list** — paginated, filterable by status and FY. Server state via React Query.
2. **New claim form** — cost code, expense date, line items (add/remove, fuel flag), live total preview that matches the server's math, react-hook-form + zod. On success the list reflects the new claim without a full reload.
3. **Claim detail** (new) — line items, ex-GST totals with GST and inc-GST shown for reference, current status, and the decision/audit history as a timeline. Approve/Reject actions live here for holders of `claims.approve`; the two-key flow must be legible (who turned the first key, what's pending).

The user-switcher decides who is "acting", but what actually enforces the rules should reflect your production instincts. A CSV import screen is **optional stretch** — if you skip it, say so in `DECISIONS.md`; the API endpoint is still required.

**Tests** — write the tests you believe earn their keep; we care about *what you chose to test* as much as the tests themselves. At least some must run against a real Postgres.

## `DECISIONS.md`

Short, bullet-style. Must cover: any changes you made to the starter code (schema included) and why; your money/rounding approach; how references stay collision-free; how totals stay reproducible when levy rates change; how you handled concurrent decisions across the two-key flow; how the final-approval event is produced; how you resolved the rejected-claims question; what you deliberately skipped and why. This document is weighted heavily.

## `AI-USAGE.md`

What you used AI for (scaffolding, tests, debugging, review…), what it got wrong and how you caught it, and anything you deliberately did by hand. Honest and specific beats impressive. "I didn't use AI" is a valid entry.

## What we do NOT want

- No real auth, S3, or email — the stubs are there for a reason.
- No new CRUD for orgs/users/projects/equipment — seeded.
- No UI theming effort.
- Don't gold-plate: your judgment about what *not* to build is part of the assessment.
