/**
 * Client-side parse of a LegacyPlant CSV for the import screen's live preview.
 *
 * Mirrors the server so the preview shows what import will actually do:
 *   - field splitting / price normalization / strict dates:
 *       api/src/claims/legacy-plant-csv.ts
 *   - grouping by `group` key (rows sharing a key are ONE claim, even when they
 *     are not adjacent) and the same-date-per-group rule:
 *       api/src/claims/claims.service.ts (importLegacyPlant)
 *
 * Row numbers are 1-based over non-empty lines (header = row 1), which is what
 * the server reports in its import errors. The server stays the source of truth
 * on import; this is only a best-effort preview.
 */

export const CSV_COLUMNS = [
  'expense_date',
  'description',
  'quantity',
  'unit_price',
  'is_fuel',
  'group',
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

/** Columns shown as table cells; `group` is rendered as the claim block header. */
export const CSV_FIELD_COLUMNS = CSV_COLUMNS.filter((c) => c !== 'group') as Exclude<
  CsvColumn,
  'group'
>[];

export interface PreviewCell {
  value: string;
  error?: string;
}

export interface PreviewRow {
  /** 1-based over non-empty lines, header = row 1 — matches server error reports. */
  rowNumber: number;
  cells: Record<CsvColumn, PreviewCell>;
  hasError: boolean;
}

export interface PreviewGroup {
  /** The group key ('' when the row's group cell is blank). */
  group: string;
  rows: PreviewRow[];
  /** Set when the group's valid rows don't all share one expense_date. */
  dateError?: string;
  /** Would the server create a claim from this group? */
  valid: boolean;
  /** Human reason shown when `valid` is false. */
  reason?: string;
}

export interface CsvPreview {
  headerOk: boolean;
  missingColumns: string[];
  groups: PreviewGroup[];
  validClaimCount: number;
  problemGroupCount: number;
}

const MAX_DESCRIPTION = 200;
const MAX_QUANTITY = 1_000_000;
const MONEY_RE = /^\d{1,10}(\.\d{1,2})?$/;

export function splitCsvLines(csv: string): string[] {
  return csv
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
}

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

export function normalizeLegacyPrice(raw: string): string {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s.replace(/^\$/, '').replace(/,/g, '');
}

export function isStrictIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day
  );
}

export function validateCell(column: CsvColumn, value: string): string | undefined {
  switch (column) {
    case 'expense_date':
      if (!value) return 'expense_date is required';
      if (!isStrictIsoDate(value)) return 'Must be a real date in YYYY-MM-DD format';
      return undefined;
    case 'description':
      if (!value) return 'description is required';
      if (value.length > MAX_DESCRIPTION) return `At most ${MAX_DESCRIPTION} characters`;
      return undefined;
    case 'quantity': {
      if (!/^\d+$/.test(value) || Number(value) < 1) return 'Must be a positive whole number';
      if (Number(value) > MAX_QUANTITY) return `Must not exceed ${MAX_QUANTITY.toLocaleString()}`;
      return undefined;
    }
    case 'unit_price': {
      const normalized = normalizeLegacyPrice(value);
      if (!normalized || !MONEY_RE.test(normalized)) {
        return 'Must be a non-negative amount with at most 2 decimals';
      }
      return undefined;
    }
    case 'is_fuel': {
      const v = value.trim().toLowerCase();
      if (!['true', '1', 'yes', 'y', 'false', '0', 'no', 'n'].includes(v)) {
        return 'Must be true/false (or 1/0)';
      }
      return undefined;
    }
    case 'group':
      if (!value) return 'group is required — rows sharing a group become one claim';
      return undefined;
  }
}

/** Returns null when there is nothing to preview yet (no header row). */
export function buildCsvPreview(csv: string): CsvPreview | null {
  const lines = splitCsvLines(csv);
  if (lines.length === 0) return null;

  const headers = splitCsvFields(lines[0]).map((h) => h.trim().toLowerCase());
  const index: Partial<Record<CsvColumn, number>> = {};
  const missingColumns: string[] = [];
  for (const name of CSV_COLUMNS) {
    const i = headers.indexOf(name);
    if (i < 0) missingColumns.push(name);
    else index[name] = i;
  }
  if (missingColumns.length > 0) {
    return { headerOk: false, missingColumns, groups: [], validClaimCount: 0, problemGroupCount: 0 };
  }

  // Group by key in first-appearance order (mirrors the server's Map) so rows
  // that share a group form ONE claim even when they are not adjacent.
  const order: string[] = [];
  const byGroup = new Map<string, PreviewRow[]>();

  for (let li = 1; li < lines.length; li++) {
    const fields = splitCsvFields(lines[li]);
    const cells = {} as Record<CsvColumn, PreviewCell>;
    let hasError = false;
    for (const column of CSV_COLUMNS) {
      const value = (fields[index[column]!] ?? '').trim();
      const error = validateCell(column, value);
      if (error) hasError = true;
      cells[column] = { value, error };
    }
    const key = cells.group.value;
    if (!byGroup.has(key)) {
      byGroup.set(key, []);
      order.push(key);
    }
    byGroup.get(key)!.push({ rowNumber: li + 1, cells, hasError });
  }

  const groups: PreviewGroup[] = [];
  let validClaimCount = 0;
  let problemGroupCount = 0;

  for (const key of order) {
    const rows = byGroup.get(key)!;
    // The server checks same-date across the fully-valid rows of a group.
    const validRows = rows.filter((r) => !r.hasError);
    const distinctDates = new Set(validRows.map((r) => r.cells.expense_date.value));
    const dateError =
      distinctDates.size > 1 ? 'All rows in a group must share the same expense_date' : undefined;

    const anyRowError = rows.some((r) => r.hasError);
    const valid = key !== '' && !anyRowError && !dateError;

    let reason: string | undefined;
    if (!valid) {
      if (key === '') reason = 'group is required';
      else if (dateError) reason = dateError;
      else reason = 'Fix the highlighted cells';
    }

    if (valid) validClaimCount++;
    else problemGroupCount++;

    groups.push({ group: key, rows, dateError, valid, reason });
  }

  return { headerOk: true, missingColumns: [], groups, validClaimCount, problemGroupCount };
}
