import { Decimal } from 'decimal.js';
import { requiresTwoKeys, TWO_KEY_THRESHOLD } from './claim-lifecycle';

describe('claim lifecycle thresholds', () => {
  it('treats totals over $1000.00 as two-key', () => {
    expect(requiresTwoKeys('1000.01')).toBe(true);
    expect(requiresTwoKeys(new Decimal('1000.01'))).toBe(true);
  });

  it('treats $1000.00 exactly as one-key', () => {
    expect(requiresTwoKeys(TWO_KEY_THRESHOLD)).toBe(false);
    expect(requiresTwoKeys('1000.00')).toBe(false);
  });

  it('treats totals under $1000.00 as one-key', () => {
    expect(requiresTwoKeys('67.47')).toBe(false);
  });
});
