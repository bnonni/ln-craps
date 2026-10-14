// Decode a BOLT11 invoice without a Lightning node. Spec: https://github.com/lightning/bolts/blob/master/11-payment-encoding.md
// The decoder does not verify the signature. The node that pays the invoice verifies it.

import { decode } from "light-bolt11-decoder";
import type { DecodedInvoice } from "./types";

/** The expiry if the invoice has no "x" field (BOLT11). */
const DEFAULT_EXPIRY_SECONDS = 3600;

export function decodeBolt11(bolt11: string): DecodedInvoice {
  const { sections } = decode(bolt11.trim());
  const field = (name: string) => (sections.find((s) => s.name === name) as { value?: unknown } | undefined)?.value;

  const paymentHash = field("payment_hash");
  if (typeof paymentHash !== "string" || !/^[0-9a-f]{64}$/.test(paymentHash)) throw new Error("invalid payment hash");
  const timestamp = field("timestamp");
  if (typeof timestamp !== "number") throw new Error("invalid timestamp");
  const expiry = field("expiry");
  const msat = BigInt((field("amount") as string | undefined) ?? "0");
  const payee = field("payee");

  return {
    paymentHash,
    amount: Number(msat / 1000n),
    hasMsatRemainder: msat % 1000n !== 0n,
    expiresAt: (timestamp + (typeof expiry === "number" ? expiry : DEFAULT_EXPIRY_SECONDS)) * 1000,
    destination: typeof payee === "string" ? payee : "",
  };
}
