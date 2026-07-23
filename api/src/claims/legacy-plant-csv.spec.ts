import {
  isStrictIsoDate,
  normalizeLegacyPrice,
  parseIsFuel,
  parseLegacyPlantCsv,
  splitCsvFields,
} from './legacy-plant-csv';

describe('legacy-plant-csv', () => {
  it('parses quoted prices with thousands separators', () => {
    expect(normalizeLegacyPrice('"1,299.50"')).toBe('1299.50');
    expect(normalizeLegacyPrice('$1,299.50')).toBe('1299.50');
  });

  it('splits quoted CSV fields', () => {
    expect(splitCsvFields('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
  });

  it('parses is_fuel variants', () => {
    expect(parseIsFuel('true')).toBe(true);
    expect(parseIsFuel('0')).toBe(false);
    expect(parseIsFuel('maybe')).toBeNull();
  });

  it('groups rows and rejects a whole group when one line is bad', () => {
    const csv = [
      'expense_date,description,quantity,unit_price,is_fuel,group',
      '2026-02-10,Diesel,3,19.99,true,A',
      '2026-02-10,Bad,,,true,A',
      '2026-02-11,Paint,1,10.00,false,B',
    ].join('\n');

    const groups = parseLegacyPlantCsv(csv);
    const a = groups.find((g) => g.group === 'A')!;
    const b = groups.find((g) => g.group === 'B')!;
    expect(a.errors.length).toBeGreaterThan(0);
    expect(a.rows).toHaveLength(1); // first row parsed; errors on second
    expect(b.errors).toHaveLength(0);
    expect(b.rows).toHaveLength(1);
  });

  it('requires header columns', () => {
    expect(() => parseLegacyPlantCsv('a,b\n1,2')).toThrow(/missing required column/);
  });

  it('accepts only real YYYY-MM-DD dates', () => {
    expect(isStrictIsoDate('2026-02-10')).toBe(true);
    expect(isStrictIsoDate('2026-02-30')).toBe(false);
    expect(isStrictIsoDate('2026-13-01')).toBe(false);
    expect(isStrictIsoDate('02/10/2026')).toBe(false);
    expect(isStrictIsoDate('2026-2-1')).toBe(false);
  });

  it('rejects a group whose row has an invalid calendar date', () => {
    const csv = [
      'expense_date,description,quantity,unit_price,is_fuel,group',
      '2026-02-30,Diesel,3,19.99,true,A',
    ].join('\n');

    const groups = parseLegacyPlantCsv(csv);
    const a = groups.find((g) => g.group === 'A')!;
    expect(a.errors.some((e) => /YYYY-MM-DD/.test(e.reason))).toBe(true);
    expect(a.rows).toHaveLength(0);
  });

  it('mirrors storage limits: oversized quantity / unit price / description', () => {
    const csv = [
      'expense_date,description,quantity,unit_price,is_fuel,group',
      '2026-02-10,Big qty,1000001,1.00,false,Q',
      '2026-02-10,Big price,1,10000000000.00,false,P',
      `2026-02-10,${'x'.repeat(201)},1,1.00,false,D`,
    ].join('\n');

    const groups = parseLegacyPlantCsv(csv);
    expect(groups.find((g) => g.group === 'Q')!.errors[0].reason).toMatch(/not exceed/);
    expect(groups.find((g) => g.group === 'P')!.errors[0].reason).toMatch(/within range/);
    expect(groups.find((g) => g.group === 'D')!.errors[0].reason).toMatch(/at most 200/);
  });
});
