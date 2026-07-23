-- Two-key / reject tracking on claims (additive, non-destructive).

ALTER TABLE "Claim" ADD COLUMN "firstApprovedById" TEXT;
ALTER TABLE "Claim" ADD COLUMN "firstApprovedAt" TIMESTAMP(3);
ALTER TABLE "Claim" ADD COLUMN "rejectedById" TEXT;
ALTER TABLE "Claim" ADD COLUMN "rejectedAt" TIMESTAMP(3);
