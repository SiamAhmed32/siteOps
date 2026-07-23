/**
 * Effective levy rate for live preview — mirrors seeded SurchargeRate rows.
 * Assessment scope: rates are seeded, not CRUD-managed in the UI.
 */
const SEEDED_RATES = [
  { effectiveFrom: '2024-07-01', ratePercent: '10.00' },
  { effectiveFrom: '2026-01-01', ratePercent: '12.50' },
] as const;

/** Rate in force on expense date (YYYY-MM-DD), or null if before any seeded rate. */
export function effectiveLevyRatePercent(expenseDate: string): string | null {
  const day = expenseDate.trim().slice(0, 10);
  if (!day) return null;
  let rate: string | null = null;
  for (const row of SEEDED_RATES) {
    if (day >= row.effectiveFrom) rate = row.ratePercent;
  }
  return rate;
}
