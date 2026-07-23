/**
 * Australian financial year: 1 July – 30 June.
 * FY26 runs 1 Jul 2025 – 30 Jun 2026 (ends 30 June 2026).
 * A claim's FY comes from its expense date only.
 */
export function financialYearFromDate(date: Date): number {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth(); // 0-based; July = 6
  return month >= 6 ? year + 1 : year;
}

/** Two-digit FY used in claim references, e.g. "26". */
export function financialYearCode(date: Date): string {
  return String(financialYearFromDate(date)).slice(-2);
}

/** Sequence key for claim refs within an org, e.g. "claim:26". */
export function claimSequenceKey(date: Date): string {
  return `claim:${financialYearCode(date)}`;
}
