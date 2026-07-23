-- Claim money: Float → Decimal, levy snapshot columns, org-scoped references.
-- Existing claim rows are cleared; re-seed after migrate.

DELETE FROM "ClaimLine";
DELETE FROM "Claim";

DROP INDEX IF EXISTS "Claim_reference_key";

ALTER TABLE "Claim" ALTER COLUMN "total" SET DATA TYPE DECIMAL(12,2);

ALTER TABLE "Claim" ADD COLUMN "levyRatePercent" DECIMAL(5,2) NOT NULL;
ALTER TABLE "Claim" ADD COLUMN "levyAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

ALTER TABLE "ClaimLine" ALTER COLUMN "unitPrice" SET DATA TYPE DECIMAL(12,2);

ALTER TABLE "SurchargeRate" ALTER COLUMN "ratePercent" SET DATA TYPE DECIMAL(5,2);

CREATE UNIQUE INDEX "Claim_orgId_reference_key" ON "Claim"("orgId", "reference");
CREATE INDEX "Claim_orgId_expenseDate_idx" ON "Claim"("orgId", "expenseDate");
CREATE INDEX "SurchargeRate_orgId_effectiveFrom_idx" ON "SurchargeRate"("orgId", "effectiveFrom");
