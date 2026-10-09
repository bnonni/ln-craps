// The interface between the casino and a Lightning node. All amounts are sats.

export interface CreatedInvoice {
  /** Hex */
  paymentHash: string;
  bolt11: string;
  expiresAt: number;
}

export type InvoiceStatus = { state: "open" } | { state: "settled"; amountPaid: number } | { state: "canceled" };

export interface DecodedInvoice {
  /** Hex */
  paymentHash: string;
  /** Zero if the invoice has no amount. */
  amount: number;
  /** True if the amount has a part that is less than 1 sat. */
  hasMsatRemainder: boolean;
  expiresAt: number;
  destination: string;
}

export type PaymentStatus =
  | { status: "succeeded"; fee: number; preimage: string }
  | { status: "failed"; reason: string }
  /** The node does not know the final result yet. Do not refund. */
  | { status: "pending" };

export interface PayRequest {
  bolt11: string;
  /** Hex */
  paymentHash: string;
  maxFee: number;
  timeoutSeconds: number;
}

export interface LightningBackend {
  readonly name: string;
  createInvoice(amount: number, memo: string, expirySeconds: number): Promise<CreatedInvoice>;
  lookupInvoice(paymentHash: string): Promise<InvoiceStatus>;
  decodeInvoice(bolt11: string): Promise<DecodedInvoice>;
  /** Must not throw for a payment failure. Throw only if the result is unknown. */
  payInvoice(request: PayRequest): Promise<PaymentStatus>;
  /** Returns "failed" only if the node is certain that it did not and will not send the payment. */
  lookupPayment(paymentHash: string): Promise<PaymentStatus>;
}
