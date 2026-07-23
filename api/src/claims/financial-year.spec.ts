import { financialYearCode, financialYearDateRange, financialYearFromDate } from './financial-year';

describe('financialYearFromDate', () => {
  it('maps Jan–Jun to the calendar year as FY', () => {
    expect(financialYearFromDate(new Date('2026-01-18T00:00:00.000Z'))).toBe(2026);
    expect(financialYearFromDate(new Date('2026-06-30T00:00:00.000Z'))).toBe(2026);
  });

  it('maps Jul–Dec to the next calendar year as FY', () => {
    expect(financialYearFromDate(new Date('2025-07-01T00:00:00.000Z'))).toBe(2026);
    expect(financialYearFromDate(new Date('2025-12-31T00:00:00.000Z'))).toBe(2026);
  });

  it('formats a two-digit FY code', () => {
    expect(financialYearCode(new Date('2026-02-10T00:00:00.000Z'))).toBe('26');
  });

  it('builds an FY date range for filters', () => {
    const { gte, lt } = financialYearDateRange('26');
    expect(gte.toISOString()).toBe('2025-07-01T00:00:00.000Z');
    expect(lt.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });
});
