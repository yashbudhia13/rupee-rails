/**
 * Bridge to the C++ secure element simulator (native/secure-element).
 *
 * The device holds its key and spend counter in a state file and is driven
 * through the `cbdc-se` CLI, one JSON object per call. Vouchers it produces
 * verify with `verifyVoucher` in offline.ts and settle at the bank exactly like
 * vouchers from the TypeScript OfflineWallet: the format is the contract.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import path from "node:path";
import { OfflineError, type Voucher } from "./offline.js";

export interface SecureElementState {
  walletId: string;
  publicKey: string;
  balance: number;
  counter: number;
  lastHash: string;
}

/** Raw 32-byte Ed25519 seed from a Node private key, for custodial enrolment of a device. */
export function seedHex(privateKey: KeyObject): string {
  const der = Buffer.from(privateKey.export({ type: "pkcs8", format: "der" }));
  return der.subarray(der.length - 32).toString("hex");
}

export function defaultSecureElementBinary(): string {
  const exe = process.platform === "win32" ? "cbdc-se.exe" : "cbdc-se";
  const dir = path.resolve(process.cwd(), "native", "secure-element", "build");
  const candidates = [path.join(dir, exe), path.join(dir, "Release", exe)];
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
}

export function secureElementAvailable(binary = defaultSecureElementBinary()): boolean {
  return existsSync(binary);
}

export class SecureElementDevice {
  constructor(
    readonly stateFile: string,
    readonly binary: string = defaultSecureElementBinary(),
  ) {}

  /** Provision a device. With `seedHex` the device gets the key the bank registered for the wallet. */
  static enrol(opts: { stateFile: string; walletId: string; seedHex?: string; binary?: string }): SecureElementDevice {
    const device = new SecureElementDevice(opts.stateFile, opts.binary ?? defaultSecureElementBinary());
    const args = ["init", "--state", opts.stateFile, "--wallet", opts.walletId];
    if (opts.seedHex) args.push("--seed", opts.seedHex);
    device.run(args);
    return device;
  }

  state(): SecureElementState {
    return JSON.parse(this.run(["state", "--state", this.stateFile])) as SecureElementState;
  }

  fund(amount: number): SecureElementState {
    return JSON.parse(this.run(["fund", "--state", this.stateFile, "--amount", String(amount)])) as SecureElementState;
  }

  createVoucher(to: string, amount: number, at: Date = new Date()): Voucher {
    const out = this.run(["create", "--state", this.stateFile, "--to", to, "--amount", String(amount), "--at", at.toISOString()]);
    return JSON.parse(out) as Voucher;
  }

  /** Ask the native side to verify a voucher; returns its independent hash as well. */
  static verify(voucher: Voucher, binary = defaultSecureElementBinary()): { ok: boolean; hash: string } {
    try {
      const out = execFileSync(binary, ["verify", "--voucher", JSON.stringify(voucher)], { encoding: "utf8" });
      return JSON.parse(out) as { ok: boolean; hash: string };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      if (e.status === 4 && e.stdout) return JSON.parse(e.stdout) as { ok: boolean; hash: string };
      throw err;
    }
  }

  /** The attacker's move: copy the state file, counter included. */
  clone(toStateFile: string): SecureElementDevice {
    copyFileSync(this.stateFile, toStateFile);
    return new SecureElementDevice(toStateFile, this.binary);
  }

  private run(args: string[]): string {
    try {
      return execFileSync(this.binary, args, { encoding: "utf8" }).trim();
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string; message: string };
      if (e.status === 3) {
        const body = e.stdout ? (JSON.parse(e.stdout) as { error?: string }) : {};
        throw new OfflineError("INSUFFICIENT_OFFLINE_BALANCE", body.error ?? "secure element refused the voucher");
      }
      throw new Error(`cbdc-se ${args[0]} failed (exit ${e.status ?? "?"}): ${(e.stderr ?? e.message).trim()}`);
    }
  }
}
