/**
 * Claim lifecycle thresholds (ex-GST totals).
 * Two-key rule: total *exceeds* $1,000.00 needs two different approvers.
 * $1,000.00 exactly is one key.
 *
 * Accepts exact decimal strings or Decimal-like values via toString() —
 * never a bare JS number — so approval routing cannot depend on IEEE-754 noise.
 */
import { Decimal } from 'decimal.js';

export const TWO_KEY_THRESHOLD = new Decimal('1000.00');

export function requiresTwoKeys(total: string | { toString(): string }): boolean {
  const raw = typeof total === 'string' ? total : total.toString();
  return new Decimal(raw).greaterThan(TWO_KEY_THRESHOLD);
}
