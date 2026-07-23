-- Claim money: Float → Decimal, levy snapshot columns, org-scoped references.
-- Non-destructive: alter types in place and backfill (no DELETE).
--
-- Note on ordering vs. fresh installs: on a clean setup this migration runs on an
-- empty Claim table (seed runs after migrate), so the backfill UPDATEs affect zero
-- rows. They exist as a real, correct data-remediation path for databases that
-- already hold claims (e.g. Priya's pre-existing rows).

DROP INDEX IF EXISTS "Claim_reference_key";

ALTER TABLE "Claim" ALTER COLUMN "total" SET DATA TYPE DECIMAL(12,2)
  USING ROUND(("total")::numeric, 2);

ALTER TABLE "ClaimLine" ALTER COLUMN "unitPrice" SET DATA TYPE DECIMAL(12,2)
  USING ROUND(("unitPrice")::numeric, 2);

ALTER TABLE "SurchargeRate" ALTER COLUMN "ratePercent" SET DATA TYPE DECIMAL(5,2)
  USING ROUND(("ratePercent")::numeric, 2);

ALTER TABLE "Claim" ADD COLUMN IF NOT EXISTS "levyRatePercent" DECIMAL(5,2);
ALTER TABLE "Claim" ADD COLUMN IF NOT EXISTS "levyAmount" DECIMAL(12,2);

-- 1) Rate in force on each claim's expense date (effective-dated surcharge).
--    No arbitrary fallback: a claim with no matching rate is left NULL so the
--    NOT NULL step below fails loudly rather than inventing a rate.
UPDATE "Claim" AS c
SET "levyRatePercent" = (
  SELECT sr."ratePercent"
  FROM "SurchargeRate" AS sr
  WHERE sr."orgId" = c."orgId"
    AND sr."effectiveFrom" <= c."expenseDate"
  ORDER BY sr."effectiveFrom" DESC
  LIMIT 1
)
WHERE c."levyRatePercent" IS NULL;

-- 2) Levy = half-up(fuel subtotal × rate / 100), once per claim.
UPDATE "Claim" AS c
SET "levyAmount" = ROUND((
  SELECT COALESCE(SUM(cl."quantity" * cl."unitPrice"), 0)
  FROM "ClaimLine" AS cl
  WHERE cl."claimId" = c."id" AND cl."isFuel" = true
) * c."levyRatePercent" / 100, 2)
WHERE c."levyAmount" IS NULL;

-- 3) Recompute total = all line totals + levy, so legacy/broken totals are corrected.
UPDATE "Claim" AS c
SET "total" = ROUND((
  SELECT COALESCE(SUM(cl."quantity" * cl."unitPrice"), 0)
  FROM "ClaimLine" AS cl
  WHERE cl."claimId" = c."id"
) + COALESCE(c."levyAmount", 0), 2);

ALTER TABLE "Claim" ALTER COLUMN "levyRatePercent" SET NOT NULL;
ALTER TABLE "Claim" ALTER COLUMN "levyAmount" SET NOT NULL;
ALTER TABLE "Claim" ALTER COLUMN "levyAmount" SET DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS "Claim_orgId_reference_key" ON "Claim"("orgId", "reference");
CREATE INDEX IF NOT EXISTS "Claim_orgId_expenseDate_idx" ON "Claim"("orgId", "expenseDate");
CREATE INDEX IF NOT EXISTS "SurchargeRate_orgId_effectiveFrom_idx" ON "SurchargeRate"("orgId", "effectiveFrom");
