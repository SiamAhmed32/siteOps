/**
 * Client-side claim totals — same algorithm as api/src/claims/claim-totals.ts
 * so the new-claim preview matches what POST /claims will persist.
 */
import { Decimal } from 'decimal.js';

export interface ClaimLineInput {
  quantity: number;
  unitPrice: string;
  isFuel: boolean;
}

export interface ClaimTotalsPreview {
  linesSubtotal: string;
  fuelSubtotal: string;
  levyAmount: string;
  total: string;
}

const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);

function roundMoneyHalfUp(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

function parseMoney(value: string, field = 'unitPrice'): Decimal {
  const raw = new Decimal(value);
  if (!raw.isFinite() || raw.isNeg()) {
    throw new Error(`${field} must be a non-negative finite decimal`);
  }
  if (raw.decimalPlaces() > 2) {
    throw new Error(`${field} must have at most 2 decimal places`);
  }
  return raw;
}

function parseRatePercent(value: string): Decimal {
  return new Decimal(value);
}

/** Returns null when inputs are incomplete or invalid (preview stays quiet). */
export function previewClaimTotals(
  lines: readonly ClaimLineInput[],
  levyRatePercent: string,
): ClaimTotalsPreview | null {
  try {
    const rate = parseRatePercent(levyRatePercent);
    let fuel = ZERO;
    let nonFuel = ZERO;

    for (const line of lines) {
      if (!Number.isInteger(line.quantity) || line.quantity < 1) return null;
      const unit = parseMoney(line.unitPrice);
      const lineTotal = unit.mul(line.quantity);
      if (line.isFuel) fuel = fuel.add(lineTotal);
      else nonFuel = nonFuel.add(lineTotal);
    }

    const levy = roundMoneyHalfUp(fuel.mul(rate).div(HUNDRED));
    const linesSubtotal = roundMoneyHalfUp(fuel.add(nonFuel));
    const total = roundMoneyHalfUp(linesSubtotal.add(levy));

    return {
      linesSubtotal: linesSubtotal.toFixed(2),
      fuelSubtotal: roundMoneyHalfUp(fuel).toFixed(2),
      levyAmount: levy.toFixed(2),
      total: total.toFixed(2),
    };
  } catch {
    return null;
  }
}
