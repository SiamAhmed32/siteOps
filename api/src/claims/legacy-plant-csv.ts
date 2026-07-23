/**
 * Parse LegacyPlant CSV exports into grouped claim drafts.
 * Columns: expense_date, description, quantity, unit_price, is_fuel, group
 * Prices may arrive as "1,299.50".
 *
 * Limitation (deliberate): assumes one physical line per row. Multiline quoted
 * fields are not supported; see DECISIONS.md.
 */

import { MAX_QUANTITY } from './claim-totals';

const MAX_DESCRIPTION = 200;

export interface LegacyPlantRow {
  rowNumber: number; // 1-based data row (header is row 1)
  expenseDate: string;
  description: string;
  quantity: number;
  unitPrice: string;
  isFuel: boolean;
  group: string;
}

export interface LegacyPlantGroup {
  group: string;
  rows: LegacyPlantRow[];
  /** Row-level problems — if any, the whole group is invalid. */
  errors: { rowNumber: number; reason: string }[];
}

const REQUIRED_HEADERS = [
  'expense_date',
  'description',
  'quantity',
  'unit_price',
  'is_fuel',
  'group',
] as const;

/** Strip BOM, normalize newlines, split into non-empty lines. */
export function splitCsvLines(csv: string): string[] {
  return csv
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
}

/** Minimal CSV splitter — supports quoted fields with commas. */
export function splitCsvFields(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  fields.push(current.trim());
  return fields;
}

/** "1,299.50" / "$1,299.50" → "1299.50" */
export function normalizeLegacyPrice(raw: string): string {
  let s = raw.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/^\$/, '').replace(/,/g, '');
  return s;
}

export function parseIsFuel(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(v)) return true;
  if (['false', '0', 'no', 'n'].includes(v)) return false;
  return null;
}

/**
 * Strict calendar date in `YYYY-MM-DD`. Rejects `2026-02-30`, `2026-13-01`,
 * `02/10/2026`, etc. — `Date.parse` is too lenient for expense dates.
 */
export function isStrictIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

/**
 * Parse CSV text into groups. Does not create claims — only structure + row errors.
 * Throws if the header row is missing required columns.
 */
export function parseLegacyPlantCsv(csv: string): LegacyPlantGroup[] {
  const lines = splitCsvLines(csv);
  if (lines.length < 2) {
    throw new Error('CSV must include a header row and at least one data row');
  }

  const headers = splitCsvFields(lines[0]).map((h) => h.trim().toLowerCase());
  const index: Record<string, number> = {};
  for (const name of REQUIRED_HEADERS) {
    const i = headers.indexOf(name);
    if (i < 0) throw new Error(`CSV missing required column: ${name}`);
    index[name] = i;
  }

  const byGroup = new Map<string, LegacyPlantGroup>();

  for (let li = 1; li < lines.length; li++) {
    const rowNumber = li + 1; // 1-based including header
    const fields = splitCsvFields(lines[li]);
    const groupKey = (fields[index.group] ?? '').trim();
    if (!byGroup.has(groupKey)) {
      byGroup.set(groupKey, { group: groupKey, rows: [], errors: [] });
    }
    const g = byGroup.get(groupKey)!;

    if (!groupKey) {
      g.errors.push({ rowNumber, reason: 'group is required' });
      continue;
    }

    const expenseDate = (fields[index.expense_date] ?? '').trim();
    const description = (fields[index.description] ?? '').trim();
    const quantityRaw = (fields[index.quantity] ?? '').trim();
    const unitPriceRaw = normalizeLegacyPrice(fields[index.unit_price] ?? '');
    const isFuelRaw = fields[index.is_fuel] ?? '';

    const rowErrors: string[] = [];
    if (!expenseDate) rowErrors.push('expense_date is required');
    else if (!isStrictIsoDate(expenseDate)) {
      rowErrors.push('expense_date must be a real date in YYYY-MM-DD format');
    }

    if (!description) rowErrors.push('description is required');
    else if (description.length > MAX_DESCRIPTION) {
      rowErrors.push(`description must be at most ${MAX_DESCRIPTION} characters`);
    }

    const quantity = Number(quantityRaw);
    if (!/^\d+$/.test(quantityRaw) || !Number.isInteger(quantity) || quantity < 1) {
      rowErrors.push('quantity must be a positive integer');
    } else if (quantity > MAX_QUANTITY) {
      rowErrors.push(`quantity must not exceed ${MAX_QUANTITY}`);
    }

    // At most 10 integer digits + 2 decimals — mirrors the DB money column (Decimal(12,2)).
    if (!unitPriceRaw || !/^\d{1,10}(\.\d{1,2})?$/.test(unitPriceRaw)) {
      rowErrors.push('unit_price must be a non-negative amount within range (max 2 decimals)');
    }

    const isFuel = parseIsFuel(isFuelRaw);
    if (isFuel === null) rowErrors.push('is_fuel must be true/false (or 1/0)');

    if (rowErrors.length > 0) {
      for (const reason of rowErrors) g.errors.push({ rowNumber, reason });
      continue;
    }

    g.rows.push({
      rowNumber,
      expenseDate,
      description,
      quantity,
      unitPrice: unitPriceRaw,
      isFuel: isFuel!,
      group: groupKey,
    });
  }

  return [...byGroup.values()];
}
