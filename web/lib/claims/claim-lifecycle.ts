/** Client-side two-key threshold check (matches api/src/claims/claim-lifecycle.ts). */
import { Decimal } from 'decimal.js';

const TWO_KEY_THRESHOLD = new Decimal('1000.00');

export function requiresTwoKeys(total: string | number): boolean {
  return new Decimal(String(total)).greaterThan(TWO_KEY_THRESHOLD);
}
