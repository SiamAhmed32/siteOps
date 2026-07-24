import { describe, expect, it } from 'vitest';
import {
  buildCsvPreview,
  isStrictIsoDate,
  normalizeLegacyPrice,
  validateCell,
} from './csv-preview';

const HEADER = 'expense_date,description,quantity,unit_price,is_fuel,group';
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');

describe('csv-preview field parsing (mirrors legacy-plant-csv)', () => {
  it('normalizes quoted / thousands / $ prices', () => {
    expect(normalizeLegacyPrice('"1,299.50"')).toBe('1299.50');
    expect(normalizeLegacyPrice('$1,299.50')).toBe('1299.50');
    expect(normalizeLegacyPrice('45.00')).toBe('45.00');
  });

  it('accepts only real YYYY-MM-DD dates', () => {
    expect(isStrictIsoDate('2026-02-10')).toBe(true);
    expect(isStrictIsoDate('2026-02-30')).toBe(false);
    expect(isStrictIsoDate('2026-13-01')).toBe(false);
    expect(isStrictIsoDate('02/10/2026')).toBe(false);
    expect(isStrictIsoDate('2026-2-1')).toBe(false);
  });

  it('validates each column the way the server does', () => {
    expect(validateCell('quantity', '0')).toBeDefined();
    expect(validateCell('quantity', '1.5')).toBeDefined();
    expect(validateCell('quantity', '3')).toBeUndefined();
    expect(validateCell('unit_price', '10000000000.00')).toBeDefined(); // > 10 int digits
    expect(validateCell('unit_price', '"1,299.50"')).toBeUndefined();
    expect(validateCell('is_fuel', 'maybe')).toBeDefined();
    expect(validateCell('is_fuel', '0')).toBeUndefined();
    expect(validateCell('group', '')).toBeDefined();
  });
});

describe('buildCsvPreview grouping & validity', () => {
  it('returns null before a header exists', () => {
    expect(buildCsvPreview('')).toBeNull();
  });

  it('flags a missing header column', () => {
    const p = buildCsvPreview('expense_date,description,quantity,unit_price,is_fuel\n2026-02-10,x,1,1.00,false')!;
    expect(p.headerOk).toBe(false);
    expect(p.missingColumns).toContain('group');
  });

  it('rejects a whole group when one row is bad', () => {
    const p = buildCsvPreview(
      csv('2026-02-10,Diesel,3,19.99,true,A', '2026-02-10,Bad,,,true,A'),
    )!;
    const a = p.groups.find((g) => g.group === 'A')!;
    expect(a.valid).toBe(false);
    expect(a.rows).toHaveLength(2); // preview shows every row, incl. the bad one
    expect(p.validClaimCount).toBe(0);
  });

  // Point 1 from the review: same expense_date per group.
  it('rejects a group whose valid rows have different dates', () => {
    const p = buildCsvPreview(
      csv('2026-02-10,Diesel,3,19.99,true,A', '2026-02-11,Timber,1,10.00,false,A'),
    )!;
    const a = p.groups.find((g) => g.group === 'A')!;
    expect(a.dateError).toMatch(/same expense_date/);
    expect(a.valid).toBe(false);
  });

  it('accepts a group whose rows share one date', () => {
    const p = buildCsvPreview(
      csv('2026-02-10,Diesel,3,19.99,true,A', '2026-02-10,Timber,1,10.00,false,A'),
    )!;
    const a = p.groups.find((g) => g.group === 'A')!;
    expect(a.dateError).toBeUndefined();
    expect(a.valid).toBe(true);
    expect(p.validClaimCount).toBe(1);
  });

  // Point 3 from the review: non-contiguous rows of the same group are ONE claim.
  it('merges non-contiguous rows that share a group', () => {
    const p = buildCsvPreview(
      csv(
        '2026-02-10,Diesel,3,19.99,true,A',
        '2026-02-11,Paint,2,45.00,false,B',
        '2026-02-10,Oil,1,29.95,false,A',
      ),
    )!;
    expect(p.groups.map((g) => g.group)).toEqual(['A', 'B']); // one A block, not two
    const a = p.groups.find((g) => g.group === 'A')!;
    expect(a.rows.map((r) => r.rowNumber)).toEqual([2, 4]); // both A rows, original numbers
    expect(a.valid).toBe(true);
  });

  // Point 2 from the review: blank lines are skipped and row numbers stay
  // aligned with the server's import report (which numbers over non-empty lines).
  it('skips blank lines and numbers rows the way the server reports them', () => {
    const p = buildCsvPreview(
      [HEADER, '2026-02-10,Diesel,3,19.99,true,A', '', '2026-02-10,Oil,1,29.95,false,A'].join('\n'),
    )!;
    const a = p.groups.find((g) => g.group === 'A')!;
    expect(a.rows.map((r) => r.rowNumber)).toEqual([2, 3]);
  });

  it('marks blank-group rows as an invalid "(empty)" group', () => {
    const p = buildCsvPreview(csv('2026-02-10,Diesel,3,19.99,true,'))!;
    const empty = p.groups.find((g) => g.group === '')!;
    expect(empty.valid).toBe(false);
    expect(empty.reason).toMatch(/group is required/);
  });
});
