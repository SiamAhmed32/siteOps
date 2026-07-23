/**
 * Server-side claim money math (ex-GST).
 *
 * Rules (from assessment glossary):
 * - Line total = quantity × unit price (exact to the cent).
 * - Levy applies to fuel lines only, computed once on the fuel subtotal,
 *   then rounded to the cent half-up.
 * - Claim total = non-fuel subtotal + fuel subtotal + levy.
 *
 * Money uses Prisma's Decimal (decimal.js) with ROUND_HALF_UP.
 * Prefer decimal *strings* for unitPrice / rates so values never pass through
 * IEEE-754 binary floats before parsing.
 */

import { Decimal } from '@prisma/client/runtime/library';

/** Preferred wire form is a decimal string, e.g. "19.99". */
export type MoneyInput = string | Decimal;

export interface ClaimLineInput {
  /** Positive integer only (matches ClaimLine.quantity in schema). */
  quantity: number;
  unitPrice: MoneyInput;
  isFuel: boolean;
}

export interface ClaimTotals {
  /** Sum of all line totals before levy (ex-GST). */
  linesSubtotal: number;
  /** Sum of fuel line totals only (ex-GST). */
  fuelSubtotal: number;
  /** Levy amount (ex-GST), half-up to the cent. */
  levyAmount: number;
  /** Final claim total ex-GST: linesSubtotal + levyAmount. */
  total: number;
}

const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);

/** Half-up to 2 decimal places (cents). */
export function roundMoneyHalfUp(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * Parse a monetary amount. Strings / Decimal only — never pass a JS number
 * that has already lost precision (e.g. 0.1 + 0.2).
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

function assertPositiveInt(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error('quantity must be a positive integer');
  }
}

function toNumber(value: Decimal): number {
  return roundMoneyHalfUp(value).toNumber();
}

/**
 * Compute claim totals from line items and an effective levy rate.
 *
 * @param lines claim line items (not mutated)
 * @param levyRatePercent e.g. "12.5" for 12.5% — rate in force on the expense date
 */
export function computeClaimTotals(
  lines: readonly ClaimLineInput[],
  levyRatePercent: MoneyInput,
): ClaimTotals {
  const rate = parseMoney(levyRatePercent, 'levyRatePercent');

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

  // Levy = half-up(fuelSubtotal × rate% / 100), once on the combined fuel subtotal.
  const levy = roundMoneyHalfUp(fuel.mul(rate).div(HUNDRED));
  const linesSubtotal = fuel.add(nonFuel);
  const total = linesSubtotal.add(levy);

  return {
    linesSubtotal: toNumber(linesSubtotal),
    fuelSubtotal: toNumber(fuel),
    levyAmount: toNumber(levy),
    total: toNumber(total),
  };
}
