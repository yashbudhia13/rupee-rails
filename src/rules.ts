/**
 * Programmable money: purpose-bound conditions attached to tokens at
 * disbursement time (the pattern RBI piloted for fertiliser subsidies).
 *
 * Rules travel with the token. Change outputs inherit them; a valid spend to a
 * qualifying merchant releases them, because the merchant receives ordinary e₹.
 */
import { canonicalJson } from "./crypto.js";

export interface GeoFence {
  lat: number;
  lng: number;
  radiusM: number;
}

export interface TokenRules {
  /** Scheme identifier, e.g. "FERT-SUBSIDY-2026". Recorded on every spend. */
  purpose: string;
  /** Public key of the scheme wallet that receives expired tokens on sweep. */
  returnTo: string;
  /** Merchant category codes the tokens may be spent at. */
  mccAllowlist?: string[];
  /** ISO timestamp after which the tokens can no longer be spent. */
  expiresAt?: string;
  /** Tokens may only be spent at a merchant located inside this circle. */
  geofence?: GeoFence;
}

export interface SpendContext {
  /** ISO timestamp the spend is evaluated at. */
  at: string;
  recipientMcc?: string;
  location?: { lat: number; lng: number };
}

export type RuleViolationCode =
  | "EXPIRED"
  | "MERCHANT_REQUIRED"
  | "MCC_NOT_ALLOWED"
  | "LOCATION_REQUIRED"
  | "OUTSIDE_GEOFENCE";

export interface RuleViolation {
  code: RuleViolationCode;
  message: string;
}

export function evaluateRules(rules: TokenRules, ctx: SpendContext): RuleViolation | null {
  if (rules.expiresAt && new Date(ctx.at).getTime() >= new Date(rules.expiresAt).getTime()) {
    return { code: "EXPIRED", message: `${rules.purpose} tokens expired at ${rules.expiresAt}` };
  }
  if (rules.mccAllowlist) {
    if (!ctx.recipientMcc) {
      return { code: "MERCHANT_REQUIRED", message: `${rules.purpose} tokens can only be paid to a merchant` };
    }
    if (!rules.mccAllowlist.includes(ctx.recipientMcc)) {
      return {
        code: "MCC_NOT_ALLOWED",
        message: `${rules.purpose} tokens cannot be spent at MCC ${ctx.recipientMcc}`,
      };
    }
  }
  if (rules.geofence) {
    if (!ctx.location) {
      return { code: "LOCATION_REQUIRED", message: `${rules.purpose} tokens require a payment location` };
    }
    const distance = haversineMeters(ctx.location, rules.geofence);
    if (distance > rules.geofence.radiusM) {
      return {
        code: "OUTSIDE_GEOFENCE",
        message: `${rules.purpose} tokens cannot be spent ${Math.round(distance / 1000)} km outside their zone`,
      };
    }
  }
  return null;
}

export function isExpired(rules: TokenRules | undefined, at: Date): boolean {
  return !!rules?.expiresAt && at.getTime() >= new Date(rules.expiresAt).getTime();
}

export function sameRules(a: TokenRules | undefined, b: TokenRules | undefined): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
