// barkd REST adapter: Lightning over Ark with Bark. Docs: https://second.tech/docs/barkd/
// The running daemon serves its API spec at /api-docs/openapi.json. This code follows barkd 0.7.1.
// barkd must listen only on localhost. Never expose it to the internet.

import { decodeBolt11 } from "./bolt11";
import type { CreatedInvoice, DecodedInvoice, InvoiceStatus, LightningBackend, PaymentStatus, PayRequest } from "./types";

export interface BarkOptions {
  url: string;
  token: string;
}

interface ReceiveInfo {
  payment_hash: string;
  /** awaiting-payment, htlcs-ready, preimage-revealed, delivering, or settled */
  state: string;
  /** The amount of the invoice */
  amount_sat: number;
}

interface SendInfo {
  payment_hash: string;
  /** unknown, start, htlc-received, payment-initiated, revocable-htlcs, revocation-stuck, or paid */
  state: string;
  preimage?: string | null;
}

interface Movement {
  /** pending, successful, failed, or canceled */
  status: string;
  offchain_fee_sat: number;
}

const POLL_INTERVAL_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;

/** barkd sent an HTTP response with an error status. */
class BarkdError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class BarkLightning implements LightningBackend {
  readonly name = "bark";
  private readonly url: string;
  private readonly token: string;

  constructor(opts: BarkOptions) {
    if (!opts.token) throw new Error("BARKD_TOKEN is required for LN_BACKEND=bark");
    this.url = opts.url.replace(/\/$/, "");
    this.token = opts.token;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.url}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok) throw new BarkdError(res.status, `barkd ${res.status}: ${body.message ?? res.statusText}`);
    return body;
  }

  async createInvoice(amount: number, memo: string, _expirySeconds: number): Promise<CreatedInvoice> {
    // barkd sets the expiry of the invoice. Thus the deposit uses the expiry from the invoice.
    const { invoice } = await this.json<{ invoice: string }>("/api/v1/lightning/receives/invoice", {
      method: "POST",
      body: JSON.stringify({ amount_sat: amount, description: memo }),
    });
    const decoded = decodeBolt11(invoice);
    if (decoded.amount !== amount || decoded.hasMsatRemainder) {
      throw new Error(`barkd made an invoice for ${decoded.amount} sats, not ${amount} sats`);
    }
    return { paymentHash: decoded.paymentHash, bolt11: invoice, expiresAt: decoded.expiresAt };
  }

  async lookupInvoice(paymentHash: string): Promise<InvoiceStatus> {
    // barkd has no canceled state for a receive. The casino expires a deposit after the invoice expires.
    let receive: ReceiveInfo;
    try {
      receive = await this.json<ReceiveInfo>(`/api/v1/lightning/receives/${paymentHash}`);
    } catch (e) {
      if (e instanceof BarkdError && e.status === 404) return { state: "open" };
      throw e;
    }
    if (receive.state === "settled") return { state: "settled", amountPaid: receive.amount_sat };
    return { state: "open" };
  }

  async decodeInvoice(bolt11: string): Promise<DecodedInvoice> {
    return decodeBolt11(bolt11);
  }

  async payInvoice({ bolt11, paymentHash, maxFee, timeoutSeconds }: PayRequest): Promise<PaymentStatus> {
    // barkd has no fee limit for a payment. Thus check the fee before the payment starts.
    let fee: number;
    try {
      fee = await this.estimateFee(bolt11);
    } catch (e) {
      return { status: "failed", reason: `The fee estimate failed: ${e instanceof Error ? e.message : e}` };
    }
    if (fee > maxFee) {
      return { status: "failed", reason: `The Lightning fee (${fee} sats) is more than the fee reserve (${maxFee} sats).` };
    }

    try {
      // barkd starts the payment and returns. The send state shows the result.
      await this.json("/api/v1/lightning/pay", { method: "POST", body: JSON.stringify({ destination: bolt11 }) });
    } catch (e) {
      // No response: barkd can still start the payment. The result is unknown.
      if (!(e instanceof BarkdError)) throw e;
      console.warn("[bark] pay:", e.message);
      const status = await this.lookupPayment(paymentHash, bolt11);
      return status.status === "failed" ? { status: "failed", reason: e.message } : status;
    }

    const deadline = Date.now() + timeoutSeconds * 1000;
    while (true) {
      const status = await this.lookupPayment(paymentHash, bolt11);
      if (status.status !== "pending" || Date.now() >= deadline) return status;
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }

  async lookupPayment(paymentHash: string, bolt11: string): Promise<PaymentStatus> {
    const send = await this.json<SendInfo>(`/api/v1/lightning/sends/${paymentHash}`);
    if (send.state === "paid") {
      return { status: "succeeded", fee: await this.paidFee(bolt11), preimage: send.preimage ?? "" };
    }
    // barkd keeps each paid send forever. "unknown" means that barkd did not start the payment,
    // or that the payment failed and barkd took back its HTLCs. In both cases, no funds left the wallet.
    if (send.state === "unknown") return { status: "failed", reason: "The payment failed." };
    // A failed payment stays in progress until the Ark server signs the revocation of the HTLCs.
    return { status: "pending" };
  }

  private async estimateFee(bolt11: string): Promise<number> {
    const { amount } = decodeBolt11(bolt11);
    return (await this.json<{ fee_sat: number }>(`/api/v1/fees/lightning/pay?amount_sat=${amount}`)).fee_sat;
  }

  /** The fee from the wallet history. If the history has no entry, the fee estimate. */
  private async paidFee(bolt11: string): Promise<number> {
    const query = new URLSearchParams({ type: "invoice", value: bolt11.trim().toLowerCase() });
    const movements = await this.json<Movement[]>(`/api/v1/history?${query}`);
    const paid = movements.find((m) => m.status === "successful");
    return paid ? paid.offchain_fee_sat : this.estimateFee(bolt11);
  }
}
