import Decimal from 'decimal.js';

Decimal.set({
  precision: 20,
  rounding: Decimal.ROUND_HALF_UP,
});

export function toDecimal(value: string | number | Decimal): Decimal {
  return new Decimal(value);
}

export function toFixed4(value: Decimal): string {
  return value.toFixed(4);
}

export function calculateFee(amount: Decimal, feeRate: string): Decimal {
  return amount.mul(new Decimal(feeRate));
}

export function decimalEquals(a: Decimal, b: Decimal): boolean {
  return a.equals(b);
}

export function sumDecimals(values: Decimal[]): Decimal {
  return values.reduce((acc, val) => acc.plus(val), new Decimal(0));
}

export function fromPrismaDecimal(value: unknown): Decimal {
  return new Decimal(String(value));
}

export { Decimal };
