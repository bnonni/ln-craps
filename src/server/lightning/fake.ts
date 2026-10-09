// An in-memory Lightning backend for development and tests. It moves no real money.
// Invoice format: lnfake:<amount>:<paymentHash>:<expiresAt>:<destination>

import { randomBytes } from "node:crypto";
import { sha256 } from "../fair";
import type { CreatedInvoice, DecodedInvoice, InvoiceStatus, LightningBackend, PaymentStatus, PayRequest } from "./types";

const NODE_ID = "fake-node";

export class FakeLightning implements LightningBackend {
  readonly name = "fake";
  private invoices = new Map<string, { amount: number; settled: boolean }>();
  private payments = new Map<string, PaymentStatus>();
  /** Tests set this to force the result of the next payInvoice call. */
  nextPayment: PaymentStatus | "throw" | null = null;

  private make(amount: number, expirySeconds: number, destination: string): CreatedInvoice {
    const preimage = randomBytes(32).toString("hex");
    const paymentHash = sha256(preimage);
    const expiresAt = Date.now() + expirySeconds * 1000;
    return { paymentHash, bolt11: `lnfake:${amount}:${paymentHash}:${expiresAt}:${destination}`, expiresAt };
  }

  async createInvoice(amount: number, _memo: string, expirySeconds: number): Promise<CreatedInvoice> {
    const invoice = this.make(amount, expirySeconds, NODE_ID);
    this.invoices.set(invoice.paymentHash, { amount, settled: false });
    return invoice;
  }

  /** Dev only: an outside wallet pays one of our invoices. */
  simulatePayment(paymentHash: string): boolean {
    const inv = this.invoices.get(paymentHash);
    if (!inv) return false;
    inv.settled = true;
    return true;
  }

  /** Dev only: an invoice from an outside wallet, to test a withdrawal. */
  externalInvoice(amount: number, expirySeconds = 600): string {
    return this.make(amount, expirySeconds, "fake-external").bolt11;
  }

  async lookupInvoice(paymentHash: string): Promise<InvoiceStatus> {
    const inv = this.invoices.get(paymentHash);
    if (!inv) return { state: "canceled" };
    return inv.settled ? { state: "settled", amountPaid: inv.amount } : { state: "open" };
  }

  async decodeInvoice(bolt11: string): Promise<DecodedInvoice> {
    const [prefix, amount, paymentHash, expiresAt, destination] = bolt11.trim().split(":");
    if (prefix !== "lnfake" || !paymentHash || !destination) throw new Error("invalid invoice");
    return {
      paymentHash,
      amount: Number(amount),
      hasMsatRemainder: false,
      expiresAt: Number(expiresAt),
      destination,
    };
  }

  async payInvoice({ bolt11, maxFee }: PayRequest): Promise<PaymentStatus> {
    const decoded = await this.decodeInvoice(bolt11);
    const forced = this.nextPayment;
    this.nextPayment = null;
    if (forced === "throw") throw new Error("connection lost");
    const result: PaymentStatus = forced ?? (
      decoded.expiresAt < Date.now()
        ? { status: "failed", reason: "invoice expired" }
        : { status: "succeeded", fee: Math.min(1, maxFee), preimage: randomBytes(32).toString("hex") }
    );
    this.payments.set(decoded.paymentHash, result);
    return result;
  }

  async lookupPayment(paymentHash: string): Promise<PaymentStatus> {
    return this.payments.get(paymentHash) ?? { status: "failed", reason: "payment not found" };
  }

  /** Tests use this to change the result that lookupPayment returns. */
  setPayment(paymentHash: string, status: PaymentStatus): void {
    this.payments.set(paymentHash, status);
  }
}
