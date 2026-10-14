import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { bech32 } from "@scure/base";
import { BarkLightning } from "../src/server/lightning/bark";
import { decodeBolt11 } from "../src/server/lightning/bolt11";

// A BOLT11 invoice with a zero signature. The decoder does not verify signatures.
function makeInvoice(opts: { amount?: string; paymentHash: string; timestamp: number; expiry?: number }): string {
  const int = (n: number, len: number) => Array.from({ length: len }, (_, i) => (n >> (5 * (len - 1 - i))) & 31);
  const tag = (code: number, data: number[]) => [code, ...int(data.length, 2), ...data];
  const words = [
    ...int(opts.timestamp, 7),
    ...tag(1, bech32.toWords(Buffer.from(opts.paymentHash, "hex"))),
    ...(opts.expiry === undefined ? [] : tag(6, int(opts.expiry, 2))),
    ...new Array(104).fill(0),
  ];
  return bech32.encode(`lntbs${opts.amount ?? ""}`, words, Number.MAX_SAFE_INTEGER);
}

const HASH = "ab".repeat(32);
const NOW_S = Math.floor(Date.now() / 1000);
const INVOICE_1000 = makeInvoice({ amount: "10u", paymentHash: HASH, timestamp: NOW_S, expiry: 600 });

describe("decodeBolt11", () => {
  test("reads the payment hash, amount, and expiry", () => {
    expect(decodeBolt11(INVOICE_1000)).toEqual({
      paymentHash: HASH,
      amount: 1000,
      hasMsatRemainder: false,
      expiresAt: (NOW_S + 600) * 1000,
      destination: "",
    });
  });

  test("uses the default expiry of 3600 seconds", () => {
    const inv = makeInvoice({ amount: "10u", paymentHash: HASH, timestamp: NOW_S });
    expect(decodeBolt11(inv).expiresAt).toBe((NOW_S + 3600) * 1000);
  });

  test("finds an amount with a part that is less than 1 sat", () => {
    // 15000p = 1.5 sats
    const d = decodeBolt11(makeInvoice({ amount: "15000p", paymentHash: HASH, timestamp: NOW_S }));
    expect(d.amount).toBe(1);
    expect(d.hasMsatRemainder).toBe(true);
  });

  test("returns 0 for an invoice with no amount", () => {
    expect(decodeBolt11(makeInvoice({ paymentHash: HASH, timestamp: NOW_S })).amount).toBe(0);
  });

  test("rejects a bad checksum", () => {
    const bad = INVOICE_1000.slice(0, -1) + (INVOICE_1000.endsWith("q") ? "p" : "q");
    expect(() => decodeBolt11(bad)).toThrow();
  });
});

// A mock barkd. Each test sets the responses.
interface Mock {
  receive: { status: number; body: unknown };
  sendStates: string[];
  payStatus: number;
  feeSat: number;
  history: unknown[];
  calls: string[];
  auth: string[];
}

let mock: Mock;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    mock.calls.push(`${req.method} ${url.pathname}`);
    mock.auth.push(req.headers.get("authorization") ?? "");
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (url.pathname === "/api/v1/lightning/receives/invoice") {
      const { amount_sat } = (await req.json()) as { amount_sat: number };
      const amount = amount_sat === 1000 ? "10u" : "20u";
      return json({ invoice: makeInvoice({ amount, paymentHash: HASH, timestamp: NOW_S, expiry: 900 }) });
    }
    if (url.pathname.startsWith("/api/v1/lightning/receives/")) return json(mock.receive.body, mock.receive.status);
    if (url.pathname === "/api/v1/fees/lightning/pay") return json({ fee_sat: mock.feeSat });
    if (url.pathname === "/api/v1/lightning/pay") {
      return mock.payStatus === 200
        ? json({ message: "Payment initiated successfully", payment_hash: HASH })
        : json({ message: "not enough funds" }, mock.payStatus);
    }
    if (url.pathname.startsWith("/api/v1/lightning/sends/")) {
      const state = mock.sendStates.length > 1 ? mock.sendStates.shift()! : mock.sendStates[0]!;
      return json({ payment_hash: HASH, state, preimage: state === "paid" ? "cd".repeat(32) : null });
    }
    if (url.pathname === "/api/v1/history") return json(mock.history);
    return json({ message: "not found" }, 404);
  },
});
afterAll(() => server.stop(true));

const bark = new BarkLightning({ url: `http://127.0.0.1:${server.port}/`, token: "secret" });
const pay = (maxFee = 20) => bark.payInvoice({ bolt11: INVOICE_1000, paymentHash: HASH, maxFee, timeoutSeconds: 3 });

beforeEach(() => {
  mock = {
    receive: { status: 200, body: { payment_hash: HASH, state: "awaiting-payment", amount_sat: 1000 } },
    sendStates: ["payment-initiated", "paid"],
    payStatus: 200,
    feeSat: 20,
    history: [{ status: "successful", offchain_fee_sat: 18 }],
    calls: [],
    auth: [],
  };
});

describe("BarkLightning", () => {
  test("requires a token", () => {
    expect(() => new BarkLightning({ url: "http://127.0.0.1:3000", token: "" })).toThrow("BARKD_TOKEN");
  });

  test("sends the token on each request", async () => {
    await bark.lookupInvoice(HASH);
    expect(mock.auth).toEqual(["Bearer secret"]);
  });

  test("a deposit uses the payment hash and the expiry from the invoice", async () => {
    const inv = await bark.createInvoice(1000, "ln-craps deposit", 60);
    expect(inv.paymentHash).toBe(HASH);
    expect(inv.expiresAt).toBe((NOW_S + 900) * 1000);
  });

  test("a deposit fails if barkd makes an invoice for a different amount", async () => {
    expect(bark.createInvoice(999, "ln-craps deposit", 60)).rejects.toThrow("not 999 sats");
  });

  test("a receive is settled only in the settled state", async () => {
    expect(await bark.lookupInvoice(HASH)).toEqual({ state: "open" });
    mock.receive.body = { payment_hash: HASH, state: "preimage-revealed", amount_sat: 1000 };
    expect(await bark.lookupInvoice(HASH)).toEqual({ state: "open" });
    mock.receive.body = { payment_hash: HASH, state: "settled", amount_sat: 1000 };
    expect(await bark.lookupInvoice(HASH)).toEqual({ state: "settled", amountPaid: 1000 });
  });

  test("an unknown receive stays open, so the casino expires it after the invoice expires", async () => {
    mock.receive = { status: 404, body: { message: "not found", resources: [] } };
    expect(await bark.lookupInvoice(HASH)).toEqual({ state: "open" });
  });

  test("a paid withdrawal gets the fee from the wallet history", async () => {
    expect(await pay()).toEqual({ status: "succeeded", fee: 18, preimage: "cd".repeat(32) });
  });

  test("a paid withdrawal with no history entry uses the fee estimate", async () => {
    mock.history = [];
    expect(await pay()).toMatchObject({ status: "succeeded", fee: 20 });
  });

  test("a fee more than the reserve fails before the payment starts", async () => {
    mock.feeSat = 21;
    expect(await pay(20)).toMatchObject({ status: "failed" });
    expect(mock.calls).not.toContain("POST /api/v1/lightning/pay");
  });

  test("an unknown send after the payment starts is a failed payment", async () => {
    mock.sendStates = ["unknown"];
    expect(await pay()).toEqual({ status: "failed", reason: "The payment failed." });
  });

  test("a payment that barkd rejects fails with the barkd message", async () => {
    mock.payStatus = 400;
    mock.sendStates = ["unknown"];
    expect(await pay()).toEqual({ status: "failed", reason: "barkd 400: not enough funds" });
  });

  test("a rejected payment that barkd started stays pending", async () => {
    mock.payStatus = 500;
    mock.sendStates = ["htlc-received"];
    expect(await pay()).toEqual({ status: "pending" });
  });

  test("a payment with HTLCs to revoke stays pending until the timeout", async () => {
    mock.sendStates = ["revocable-htlcs"];
    expect(await bark.lookupPayment(HASH, INVOICE_1000)).toEqual({ status: "pending" });
    expect(await bark.lookupPayment(HASH, INVOICE_1000)).toEqual({ status: "pending" });
  });

  test("a payment fails before it starts if barkd does not answer the fee estimate", async () => {
    const down = new BarkLightning({ url: "http://127.0.0.1:1", token: "secret" });
    expect(await down.payInvoice({ bolt11: INVOICE_1000, paymentHash: HASH, maxFee: 20, timeoutSeconds: 1 })).toMatchObject({
      status: "failed",
    });
  });
});
