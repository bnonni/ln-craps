// LND REST adapter. Docs: https://lightning.engineering/api-docs/api/lnd/
// The macaroon needs these permissions: invoices:read, invoices:write, offchain:read, offchain:write.
// Example: lncli bakemacaroon invoices:read invoices:write offchain:read offchain:write --save_to craps.macaroon

import { readFileSync } from "node:fs";
import type { CreatedInvoice, DecodedInvoice, InvoiceStatus, LightningBackend, PaymentStatus, PayRequest } from "./types";

export interface LndOptions {
  restUrl: string;
  macaroonPath: string;
  tlsCertPath: string;
}

interface LndPayment {
  status?: "UNKNOWN" | "IN_FLIGHT" | "SUCCEEDED" | "FAILED" | "INITIATED";
  fee_sat?: string;
  payment_preimage?: string;
  failure_reason?: string;
}

interface LndError {
  code?: number;
  message?: string;
}

const GRPC_NOT_FOUND = 5;

const hexToBase64Url = (hex: string) => Buffer.from(hex, "hex").toString("base64url");
const base64ToHex = (b64: string) => Buffer.from(b64, "base64").toString("hex");

export class LndLightning implements LightningBackend {
  readonly name = "lnd";
  private readonly url: string;
  private readonly macaroon: string;
  private readonly ca: string | undefined;

  constructor(opts: LndOptions) {
    if (!opts.macaroonPath) throw new Error("LND_MACAROON_PATH is required for LN_BACKEND=lnd");
    this.url = opts.restUrl.replace(/\/$/, "");
    this.macaroon = readFileSync(opts.macaroonPath).toString("hex");
    this.ca = opts.tlsCertPath ? readFileSync(opts.tlsCertPath, "utf8") : undefined;
  }

  private fetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.url}${path}`, {
      ...init,
      headers: { "Grpc-Metadata-macaroon": this.macaroon, "Content-Type": "application/json", ...init.headers },
      tls: this.ca ? { ca: this.ca } : undefined,
    });
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetch(path, init);
    const body = (await res.json().catch(() => ({}))) as T & LndError;
    if (!res.ok) throw new Error(`LND ${res.status}: ${body.message ?? res.statusText}`);
    return body;
  }

  /**
   * Read a server stream of JSON lines. Each line is { result } or { error }.
   * "first" returns the first message and closes the stream. "last" waits for the end of the stream.
   */
  private async streamMessage(
    mode: "first" | "last",
    path: string,
    init?: RequestInit,
  ): Promise<{ result?: LndPayment; error?: LndError }> {
    const res = await this.fetch(path, init);
    if (!res.body) throw new Error(`LND ${res.status}: no response body`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let last: string | undefined;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) last = line;
        if (mode === "first" && last) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    // In "first" mode, the buffer can hold a part of the next line. Ignore it.
    if (buffer.trim() && (mode === "last" || !last)) last = buffer;
    if (!last) throw new Error(`LND ${res.status}: empty stream`);
    const msg = JSON.parse(last) as { result?: LndPayment; error?: LndError } & LndPayment & LndError;
    if (msg.result || msg.error) return msg;
    // Some versions do not wrap the message.
    return res.ok && msg.status ? { result: msg } : { error: msg };
  }

  private static toStatus(p: LndPayment): PaymentStatus {
    if (p.status === "SUCCEEDED") {
      return { status: "succeeded", fee: Number(p.fee_sat ?? 0), preimage: p.payment_preimage ?? "" };
    }
    if (p.status === "FAILED") return { status: "failed", reason: p.failure_reason ?? "FAILED" };
    return { status: "pending" };
  }

  async createInvoice(amount: number, memo: string, expirySeconds: number): Promise<CreatedInvoice> {
    const res = await this.json<{ r_hash: string; payment_request: string }>("/v1/invoices", {
      method: "POST",
      body: JSON.stringify({ value: String(amount), memo, expiry: String(expirySeconds) }),
    });
    return {
      paymentHash: base64ToHex(res.r_hash),
      bolt11: res.payment_request,
      expiresAt: Date.now() + expirySeconds * 1000,
    };
  }

  async lookupInvoice(paymentHash: string): Promise<InvoiceStatus> {
    const inv = await this.json<{ state?: string; amt_paid_sat?: string }>(`/v1/invoice/${paymentHash}`);
    if (inv.state === "SETTLED") return { state: "settled", amountPaid: Number(inv.amt_paid_sat ?? 0) };
    if (inv.state === "CANCELED") return { state: "canceled" };
    return { state: "open" };
  }

  async decodeInvoice(bolt11: string): Promise<DecodedInvoice> {
    const d = await this.json<{
      destination: string;
      payment_hash: string;
      num_satoshis?: string;
      num_msat?: string;
      timestamp: string;
      expiry: string;
    }>(`/v1/payreq/${encodeURIComponent(bolt11.trim())}`);
    const msat = BigInt(d.num_msat ?? "0");
    return {
      paymentHash: d.payment_hash,
      amount: Number(d.num_satoshis ?? 0),
      hasMsatRemainder: msat % 1000n !== 0n,
      expiresAt: (Number(d.timestamp) + Number(d.expiry)) * 1000,
      destination: d.destination,
    };
  }

  async payInvoice({ bolt11, paymentHash, maxFee, timeoutSeconds }: PayRequest): Promise<PaymentStatus> {
    try {
      const msg = await this.streamMessage("last", "/v2/router/send", {
        method: "POST",
        body: JSON.stringify({
          payment_request: bolt11,
          fee_limit_sat: String(maxFee),
          timeout_seconds: timeoutSeconds,
          no_inflight_updates: true,
        }),
        signal: AbortSignal.timeout((timeoutSeconds + 15) * 1000),
      });
      if (msg.result) {
        const status = LndLightning.toStatus(msg.result);
        if (status.status !== "pending") return status;
      }
    } catch (e) {
      console.warn("[lnd] send payment did not finish:", e instanceof Error ? e.message : e);
    }
    // The send call did not give a final result. Ask the payment database.
    return this.lookupPayment(paymentHash);
  }

  async lookupPayment(paymentHash: string): Promise<PaymentStatus> {
    const msg = await this.streamMessage("first", `/v2/router/track/${hexToBase64Url(paymentHash)}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (msg.result) return LndLightning.toStatus(msg.result);
    // NotFound means that LND has no record of this payment. Thus it did not send it.
    if (msg.error?.code === GRPC_NOT_FOUND) return { status: "failed", reason: msg.error.message ?? "payment not found" };
    throw new Error(`LND track payment: ${msg.error?.message ?? "unknown error"}`);
  }
}
