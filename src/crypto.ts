/**
 * Ed25519 signing, SHA-256 hashing and canonical JSON, all from node:crypto.
 *
 * Public keys travel as 32-byte hex strings. Private keys stay as KeyObjects so
 * they are never accidentally serialised into a log or an API response.
 */
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

export interface KeyPair {
  /** Raw 32-byte Ed25519 public key, hex encoded. */
  publicKey: string;
  privateKey: KeyObject;
}

/** DER prefix for an Ed25519 SubjectPublicKeyInfo; the raw key follows it. */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = Buffer.from(publicKey.export({ type: "spki", format: "der" }));
  return { publicKey: der.subarray(der.length - 32).toString("hex"), privateKey };
}

export function isPublicKeyHex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function publicKeyFromHex(hex: string): KeyObject {
  if (!isPublicKeyHex(hex)) throw new Error("invalid public key");
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(hex, "hex")]),
    format: "der",
    type: "spki",
  });
}

export function signBytes(privateKey: KeyObject, message: Uint8Array): string {
  return sign(null, message, privateKey).toString("hex");
}

export function verifyBytes(publicKeyHex: string, message: Uint8Array, signatureHex: string): boolean {
  try {
    return verify(null, message, publicKeyFromHex(publicKeyHex), Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** JSON with object keys sorted recursively and undefined values dropped, so hashes and signatures are stable. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const v = source[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function signCanonical(privateKey: KeyObject, payload: unknown): string {
  return signBytes(privateKey, Buffer.from(canonicalJson(payload)));
}

export function verifyCanonical(publicKeyHex: string, payload: unknown, signatureHex: string): boolean {
  return verifyBytes(publicKeyHex, Buffer.from(canonicalJson(payload)), signatureHex);
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export const ZERO_HASH = "0".repeat(64);
