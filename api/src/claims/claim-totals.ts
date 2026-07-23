/**
 * Server-side claim money math (ex-GST).
 *
 * Money uses `decimal.js` (same library Prisma Decimal wraps) with ROUND_HALF_UP.
 * Prefer decimal *strings* on the wire so values never pass through IEEE-754 floats.
 * All returned amounts stay as Decimal — never JS number — until a deliberate JSON boundary.
 */

import { Decimal } from 'decimal.js';

/** Preferred wire form is a decimal string, e.g. "19.99". */
export type MoneyInput = string | Decimal;
export type RateInput = string | Decimal;

export interface ClaimLineInput {
  /** Positive integer only (matches ClaimLine.quantity in schema). */
  quantity: number;
  unitPrice: MoneyInput;
  isFuel: boolean;
}

export interface ClaimTotals {
  linesSubtotal: Decimal;
  fuelSubtotal: Decimal;
  levyAmount: Decimal;
  total: Decimal;
}

const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);

/** Half-up to 2 decimal places (cents). */
export function roundMoneyHalfUp(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * Parse a monetary amount (unit prices, line totals). Max 2 decimal places.
 * Strings / Decimal only — never pass a JS number.
 */
export function parseMoney(value: MoneyInput, field = 'amount'): Decimal {
  const raw = value instanceof Decimal ? value : new Decimal(value);
  if (!raw.isFinite() || raw.isNeg()) {
    throw new Error(`${field} must be a non-negative finite decimal`);
  }
  if (raw.decimalPlaces() > 2) {
    throw new Error(`${field} must have at most 2 decimal places`);
  }
  return raw;
}

/**
 * Parse a levy rate percent (e.g. "12.5"). Separate from money — rates are not cents.
 * Allows up to 4 decimal places of input precision.
 */
export function parseRatePercent(value: RateInput, field = 'levyRatePercent'): Decimal {
  const raw = value instanceof Decimal ? value : new Decimal(value);
  if (!raw.isFinite() || raw.isNeg()) {
    throw new Error(`${field} must be a non-negative finite decimal`);
  }
  if (raw.decimalPlaces() > 4) {
    throw new Error(`${field} must have at most 4 decimal places`);
  }
  return raw;
}

function assertPositiveInt(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error('quantity must be a positive integer');
  }
}

/**
 * Compute claim totals from line items and an effective levy rate.
 * Returns Decimals quantized to 2 dp (half-up) for money fields.
 */
export function computeClaimTotals(
  lines: readonly ClaimLineInput[],
  levyRatePercent: RateInput,
): ClaimTotals {
  const rate = parseRatePercent(levyRatePercent);

  let fuel = ZERO;
  let nonFuel = ZERO;

  for (const line of lines) {
    assertPositiveInt(line.quantity);
    const unit = parseMoney(line.unitPrice, 'unitPrice');
    const lineTotal = unit.mul(line.quantity);
    if (line.isFuel) {
      fuel = fuel.add(lineTotal);
    } else {
      nonFuel = nonFuel.add(lineTotal);
    }
  }

  const levy = roundMoneyHalfUp(fuel.mul(rate).div(HUNDRED));
  const linesSubtotal = roundMoneyHalfUp(fuel.add(nonFuel));
  const total = roundMoneyHalfUp(linesSubtotal.add(levy));

  return {
    linesSubtotal,
    fuelSubtotal: roundMoneyHalfUp(fuel),
    levyAmount: levy,
    total,
  };
}
