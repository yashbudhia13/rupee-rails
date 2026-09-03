/**
 * Money is always integer paise. Tokens are cash-like: every token carries one
 * of the standard e₹ denominations, so a transfer of an arbitrary amount is
 * expressed as spending some tokens and re-denominating the outputs.
 */

/** Standard retail e₹ denominations in paise, largest first: ₹500 ... 50p. */
export const DENOMINATIONS_PAISE: readonly number[] = [
  50_000, 20_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100, 50,
];

export const SMALLEST_UNIT = 50;

export class MoneyError extends Error {
  constructor(
    readonly code: "INVALID_AMOUNT",
    message: string,
  ) {
    super(message);
    this.name = "MoneyError";
  }
}

/** Amount must be a positive integer number of paise and a multiple of the smallest denomination. */
export function assertPaise(amount: unknown): asserts amount is number {
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
    throw new MoneyError("INVALID_AMOUNT", `amount must be a positive integer in paise, got ${String(amount)}`);
  }
  if (amount % SMALLEST_UNIT !== 0) {
    throw new MoneyError("INVALID_AMOUNT", `amount must be a multiple of ${SMALLEST_UNIT} paise, got ${amount}`);
  }
}

/** Split an amount into standard denominations, largest first. Greedy is exact for this coin system. */
export function denominate(amount: number): number[] {
  assertPaise(amount);
  const out: number[] = [];
  let remaining = amount;
  for (const d of DENOMINATIONS_PAISE) {
    while (remaining >= d) {
      out.push(d);
      remaining -= d;
    }
  }
  if (remaining !== 0) throw new MoneyError("INVALID_AMOUNT", `cannot denominate ${amount}`);
  return out;
}

export function rupees(value: number): number {
  return Math.round(value * 100);
}

export function formatInr(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  // Indian digit grouping: 12,34,567
  const s = whole.toString();
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3 : last3;
  return `${sign}₹${grouped}.${frac.toString().padStart(2, "0")}`;
}

export function sum(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}
