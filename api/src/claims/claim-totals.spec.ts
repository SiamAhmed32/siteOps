import { Decimal } from '@prisma/client/runtime/library';
import {
  computeClaimTotals,
  parseMoney,
  roundMoneyHalfUp,
  type ClaimLineInput,
} from './claim-totals';

describe('claim totals / levy (Decimal)', () => {
  describe('roundMoneyHalfUp', () => {
    it('rounds a half-cent up', () => {
      // 0.125 → 0.13
      expect(roundMoneyHalfUp(new Decimal('0.125')).toString()).toBe('0.13');
      expect(roundMoneyHalfUp(new Decimal('7.49625')).toString()).toBe('7.5');
      expect(roundMoneyHalfUp(new Decimal('2.4')).toString()).toBe('2.4');
    });
  });

  describe('parseMoney', () => {
    it('parses decimal strings exactly', () => {
      expect(parseMoney('19.99').toString()).toBe('19.99');
      expect(parseMoney('1.00').toString()).toBe('1');
    });

    it('accepts values that would drift as IEEE floats when passed as strings', () => {
      // 0.1 + 0.2 as floats is 0.30000000000000004; as decimals it is exact.
      const a = parseMoney('0.1');
      const b = parseMoney('0.2');
      expect(a.add(b).toString()).toBe('0.3');
    });

    it('rejects more than 2 decimal places', () => {
      expect(() => parseMoney('1.005')).toThrow(/at most 2 decimal places/);
    });

    it('rejects negatives', () => {
      expect(() => parseMoney('-1.00')).toThrow(/non-negative/);
    });
  });

  /**
   * Golden examples from the assessment brief (12.5% levy rate).
   * Prices as strings — the wire format we will use on create DTOs.
   */
  describe('golden examples at 12.5% levy', () => {
    it('one fuel line 3 × $19.99 → total $67.47', () => {
      const result = computeClaimTotals(
        [{ quantity: 3, unitPrice: '19.99', isFuel: true }],
        '12.5',
      );

      expect(result.fuelSubtotal).toBe(59.97);
      expect(result.levyAmount).toBe(7.5);
      expect(result.total).toBe(67.47);
    });

    it('two fuel $1.00 + one non-fuel $5.00 → total $7.25', () => {
      const result = computeClaimTotals(
        [
          { quantity: 1, unitPrice: '1.00', isFuel: true },
          { quantity: 1, unitPrice: '1.00', isFuel: true },
          { quantity: 1, unitPrice: '5.00', isFuel: false },
        ],
        '12.5',
      );

      expect(result.fuelSubtotal).toBe(2);
      expect(result.levyAmount).toBe(0.25);
      expect(result.linesSubtotal).toBe(7);
      expect(result.total).toBe(7.25);
    });
  });

  describe('levy behaviour', () => {
    it('rounds levy half-up when the raw levy lands on a half-cent', () => {
      // $1.00 fuel × 12.5% = 0.125 → 0.13
      const result = computeClaimTotals(
        [{ quantity: 1, unitPrice: '1.00', isFuel: true }],
        '12.5',
      );
      expect(result.levyAmount).toBe(0.13);
      expect(result.total).toBe(1.13);
    });

    it('computes levy once on the fuel subtotal, not per line', () => {
      // Per-line: 0.125 → 0.13 each = 0.26. Combined: 2.00 × 12.5% = 0.25.
      const result = computeClaimTotals(
        [
          { quantity: 1, unitPrice: '1.00', isFuel: true },
          { quantity: 1, unitPrice: '1.00', isFuel: true },
        ],
        '12.5',
      );
      expect(result.levyAmount).toBe(0.25);
      expect(result.total).toBe(2.25);
    });

    it('does not apply levy when there are no fuel lines', () => {
      const result = computeClaimTotals(
        [{ quantity: 2, unitPrice: '10.00', isFuel: false }],
        '12.5',
      );
      expect(result.fuelSubtotal).toBe(0);
      expect(result.levyAmount).toBe(0);
      expect(result.total).toBe(20);
    });

    it('handles zero fuel subtotal with empty lines as zero total', () => {
      const result = computeClaimTotals([], '12.5');
      expect(result.fuelSubtotal).toBe(0);
      expect(result.levyAmount).toBe(0);
      expect(result.total).toBe(0);
    });

    it('uses the provided rate (10%) instead of a hard-coded 12.5%', () => {
      const result = computeClaimTotals(
        [{ quantity: 1, unitPrice: '100.00', isFuel: true }],
        '10',
      );
      expect(result.levyAmount).toBe(10);
      expect(result.total).toBe(110);
    });

    it('supports a large but permitted line total', () => {
      const result = computeClaimTotals(
        [{ quantity: 1000, unitPrice: '9999.99', isFuel: false }],
        '12.5',
      );
      expect(result.total).toBe(9_999_990);
    });
  });

  describe('quantity invariants', () => {
    it('rejects non-integer quantity', () => {
      expect(() =>
        computeClaimTotals([{ quantity: 1.5, unitPrice: '10.00', isFuel: false }], '12.5'),
      ).toThrow(/positive integer/);
    });

    it('rejects zero and negative quantity', () => {
      expect(() =>
        computeClaimTotals([{ quantity: 0, unitPrice: '10.00', isFuel: false }], '12.5'),
      ).toThrow(/positive integer/);
      expect(() =>
        computeClaimTotals([{ quantity: -1, unitPrice: '10.00', isFuel: false }], '12.5'),
      ).toThrow(/positive integer/);
    });
  });

  describe('input immutability', () => {
    it("does not mutate the caller's line objects", () => {
      const lines: ClaimLineInput[] = [
        { quantity: 1, unitPrice: '19.99', isFuel: true },
      ];
      const snapshot = structuredClone(lines);
      computeClaimTotals(lines, '12.5');
      expect(lines).toEqual(snapshot);
    });
  });
});
