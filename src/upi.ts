/**
 * UPI QR payloads. Merchants already print `upi://pay?...` codes; an e₹ wallet
 * that can read them is interoperable with the existing acceptance network.
 */
import { assertPaise } from "./money.js";

export interface UpiPayIntent {
  /** Payee VPA, e.g. `kisan.agro@bank-a`. */
  vpa: string;
  name?: string;
  /** Amount in paise when the QR is a fixed-amount code. */
  amount?: number;
  currency: string;
  mcc?: string;
  note?: string;
  /** Merchant transaction reference (`tr`). */
  reference?: string;
}

export class UpiError extends Error {
  constructor(
    readonly code: "INVALID_QR",
    message: string,
  ) {
    super(message);
    this.name = "UpiError";
  }
}

export function parseUpiQr(text: string): UpiPayIntent {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new UpiError("INVALID_QR", "not a URL");
  }
  // `upi:` is not a special scheme, so WHATWG parsing puts "pay" in the host for
  // `upi://pay?...` and in the path for `upi:pay?...`. Accept both spellings.
  const target = url.host || url.pathname.replace(/^\/*/, "");
  if (url.protocol !== "upi:" || target !== "pay") {
    throw new UpiError("INVALID_QR", "expected a upi://pay intent");
  }
  const p = url.searchParams;
  const vpa = p.get("pa");
  if (!vpa || !/^[\w.-]+@[\w.-]+$/.test(vpa)) throw new UpiError("INVALID_QR", "missing or malformed payee address (pa)");
  const currency = p.get("cu") ?? "INR";
  if (currency !== "INR") throw new UpiError("INVALID_QR", `unsupported currency ${currency}`);

  const intent: UpiPayIntent = { vpa, currency };
  const name = p.get("pn");
  if (name) intent.name = name;
  const am = p.get("am");
  if (am) {
    if (!/^\d+(\.\d{1,2})?$/.test(am)) throw new UpiError("INVALID_QR", `malformed amount ${am}`);
    const paise = Math.round(Number(am) * 100);
    try {
      assertPaise(paise);
    } catch {
      throw new UpiError("INVALID_QR", `amount ${am} is not payable in e₹ denominations`);
    }
    intent.amount = paise;
  }
  const mcc = p.get("mc");
  if (mcc) {
    if (!/^\d{4}$/.test(mcc)) throw new UpiError("INVALID_QR", `malformed MCC ${mcc}`);
    intent.mcc = mcc;
  }
  const note = p.get("tn");
  if (note) intent.note = note;
  const reference = p.get("tr");
  if (reference) intent.reference = reference;
  return intent;
}

export function buildUpiQr(intent: { vpa: string; name?: string; amount?: number; mcc?: string; note?: string; reference?: string }): string {
  const p = new URLSearchParams();
  p.set("pa", intent.vpa);
  if (intent.name) p.set("pn", intent.name);
  if (intent.amount !== undefined) p.set("am", (intent.amount / 100).toFixed(2));
  p.set("cu", "INR");
  if (intent.mcc) p.set("mc", intent.mcc);
  if (intent.note) p.set("tn", intent.note);
  if (intent.reference) p.set("tr", intent.reference);
  return `upi://pay?${p.toString()}`;
}
