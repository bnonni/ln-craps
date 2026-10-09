import { beforeEach, describe, expect, test } from "bun:test";
import type {
  AccountState,
  CreateAccountResponse,
  DepositResponse,
  RollResponse,
  RollsResponse,
  RotateSeedResponse,
  WithdrawalResponse,
} from "../src/shared/api";
import { emptyLayout, layoutOf, stakeOf, type Layout } from "../src/shared/craps";
import { verifyRoll } from "../src/shared/fair";
import { createApp } from "../src/server/app";
import { Casino } from "../src/server/casino";
import { loadConfig } from "../src/server/config";
import { openDb } from "../src/server/db";
import { FakeLightning } from "../src/server/lightning";

let ln: FakeLightning;
let casino: Casino;
let app: ReturnType<typeof createApp>;
let token: string;

async function call<T>(method: string, path: string, body?: unknown, auth = token): Promise<{ status: number; data: T }> {
  const res = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as T };
}

async function deposit(amount: number): Promise<DepositResponse> {
  const { data } = await call<DepositResponse>("POST", "/api/deposits", { amount });
  return (await call<DepositResponse>("POST", `/api/dev/deposits/${data.paymentHash}/pay`)).data;
}

beforeEach(async () => {
  ln = new FakeLightning();
  casino = new Casino(openDb(":memory:"), { ...loadConfig(), maxBet: 10_000 }, ln);
  app = createApp(casino);
  const { data } = await call<CreateAccountResponse>("POST", "/api/accounts", undefined, "");
  token = data.token;
});

describe("accounts", () => {
  test("a new account has no balance and an empty table", async () => {
    const { status, data } = await call<AccountState>("GET", "/api/me");
    expect(status).toBe(200);
    expect(data.balance).toBe(0);
    expect(data.fairness.nonce).toBe(0);
    expect(data.fairness.serverSeedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.backend).toBe("fake");
  });

  test("a request with no key or a wrong key gets 401", async () => {
    expect((await call("GET", "/api/me", undefined, "")).status).toBe(401);
    expect((await call("GET", "/api/me", undefined, "wrong")).status).toBe(401);
  });
});

describe("deposits", () => {
  test("a paid invoice credits the balance one time", async () => {
    const { status, data } = await call<DepositResponse>("POST", "/api/deposits", { amount: 5000 });
    expect(status).toBe(201);
    expect(data.state).toBe("pending");
    ln.simulatePayment(data.paymentHash);
    await casino.syncDeposits();
    await casino.syncDeposits();
    const after = await call<DepositResponse>("GET", `/api/deposits/${data.paymentHash}`);
    expect(after.data.state).toBe("settled");
    expect(after.data.balance).toBe(5000);
  });

  test("bad amounts are rejected", async () => {
    for (const amount of [0, -5, 1.5, "100", 10_000_000]) {
      expect((await call("POST", "/api/deposits", { amount })).status).toBe(400);
    }
  });
});

describe("game", () => {
  test("a roll needs a bet", async () => {
    await deposit(1000);
    const { status, data } = await call<{ error: string }>("POST", "/api/roll", { layout: emptyLayout() });
    expect(status).toBe(400);
    expect(data.error).toMatch(/Put a bet/);
  });

  test("a bet that costs more than the balance is rejected", async () => {
    await deposit(100);
    const { status } = await call("POST", "/api/roll", { layout: { ...emptyLayout(), pass: 101 } });
    expect(status).toBe(400);
    expect((await call<AccountState>("GET", "/api/me")).data.balance).toBe(100);
  });

  test("a rule error does not change the balance or the table", async () => {
    await deposit(1000);
    const { status, data } = await call<{ error: string }>("PUT", "/api/table", { layout: { ...emptyLayout(), come: 10 } });
    expect(status).toBe(400);
    expect(data.error).toMatch(/need a point/);
    const me = (await call<AccountState>("GET", "/api/me")).data;
    expect(me.balance).toBe(1000);
    expect(stakeOf(me.table)).toBe(0);
  });

  test("balance + stakes = deposits + net, over 300 rolls; each roll verifies after rotation", async () => {
    await deposit(1_000_000);
    let totalNet = 0;
    let state = (await call<AccountState>("GET", "/api/me")).data;
    for (let i = 0; i < 300; i++) {
      const layout: Layout = layoutOf(state.table);
      if (state.table.point === null) {
        layout.pass = 100;
        layout.dontPass = i % 3 === 0 ? 50 : 0;
      } else {
        layout.passOdds = layout.pass > 0 ? (state.table.point === 6 || state.table.point === 8 ? 500 : 300) : 0;
        layout.come = i % 2 === 0 ? 20 : 0;
      }
      layout.place = { 6: 12, 8: 12 };
      layout.field = i % 4 === 0 ? 10 : 0;
      const { status, data } = await call<RollResponse>("POST", "/api/roll", { layout });
      expect(status).toBe(200);
      totalNet += data.roll.net;
      expect(data.balance + stakeOf(data.table)).toBe(1_000_000 + totalNet);
      state = { ...state, balance: data.balance, table: data.table };
    }

    const before = (await call<RollsResponse>("GET", "/api/rolls?limit=500")).data.rolls;
    expect(before).toHaveLength(300);
    expect(before.every((r) => r.serverSeed === null)).toBe(true);

    const rotated = await call<RotateSeedResponse>("POST", "/api/seeds/rotate", { clientSeed: "my-new-seed" });
    expect(rotated.data.previousSeed.rolls).toBe(300);
    expect(rotated.data.fairness).toMatchObject({ clientSeed: "my-new-seed", nonce: 0 });

    const after = (await call<RollsResponse>("GET", "/api/rolls?limit=500")).data.rolls;
    for (const r of after) {
      expect(r.serverSeed).not.toBeNull();
      expect(await verifyRoll({ ...r, serverSeed: r.serverSeed! })).toBe(true);
    }
  });

  test("a bad client seed is rejected", async () => {
    for (const clientSeed of ["", "has space", "x".repeat(65), 42]) {
      expect((await call("POST", "/api/seeds/rotate", { clientSeed })).status).toBe(400);
    }
  });
});

describe("withdrawals", () => {
  const withdraw = (bolt11: string) => call<WithdrawalResponse & { error: string }>("POST", "/api/withdrawals", { bolt11 });

  test("a successful payment debits the amount and the real fee", async () => {
    await deposit(10_000);
    const { data } = await withdraw(ln.externalInvoice(4000));
    expect(data).toMatchObject({ state: "succeeded", amount: 4000, fee: 1, feeReserve: 20 });
    expect(data.balance).toBe(10_000 - 4000 - 1);
  });

  test("a failed payment refunds everything", async () => {
    await deposit(10_000);
    ln.nextPayment = { status: "failed", reason: "no route" };
    const { data } = await withdraw(ln.externalInvoice(4000));
    expect(data).toMatchObject({ state: "failed", error: "no route", balance: 10_000 });
  });

  test("an unknown result keeps the funds reserved until the reconciler knows the result", async () => {
    await deposit(10_000);
    ln.nextPayment = "throw";
    const bolt11 = ln.externalInvoice(4000);
    const { data } = await withdraw(bolt11);
    expect(data).toMatchObject({ state: "pending", balance: 10_000 - 4000 - 20 });

    // A second withdrawal must wait.
    expect((await withdraw(ln.externalInvoice(10))).status).toBe(409);

    ln.setPayment(data.paymentHash, { status: "pending" });
    await casino.syncWithdrawals(0);
    expect((await call<WithdrawalResponse>("GET", `/api/withdrawals/${data.paymentHash}`)).data.state).toBe("pending");

    ln.setPayment(data.paymentHash, { status: "succeeded", fee: 3, preimage: "00" });
    await casino.syncWithdrawals(0);
    const done = (await call<WithdrawalResponse>("GET", `/api/withdrawals/${data.paymentHash}`)).data;
    expect(done).toMatchObject({ state: "succeeded", fee: 3, balance: 10_000 - 4000 - 3 });
  });

  test("the reconciler refunds a payment that the node never sent", async () => {
    await deposit(10_000);
    ln.nextPayment = "throw";
    const { data } = await withdraw(ln.externalInvoice(4000));
    await casino.syncWithdrawals(0);
    const done = (await call<WithdrawalResponse>("GET", `/api/withdrawals/${data.paymentHash}`)).data;
    expect(done).toMatchObject({ state: "failed", balance: 10_000 });
  });

  test("bad invoices are rejected", async () => {
    await deposit(10_000);
    const used = ln.externalInvoice(100);
    await withdraw(used);
    expect((await withdraw(used)).data.error).toMatch(/already used/);
    expect((await withdraw("not an invoice")).data.error).toMatch(/not a valid/);
    expect((await withdraw(ln.externalInvoice(0))).data.error).toMatch(/must have an amount/);
    expect((await withdraw(ln.externalInvoice(100, -10))).data.error).toMatch(/expired/);
    expect((await withdraw(ln.externalInvoice(20_000))).data.error).toMatch(/balance is too low/);
    const own = (await call<DepositResponse>("POST", "/api/deposits", { amount: 100 })).data.bolt11;
    expect((await withdraw(own)).data.error).toMatch(/deposit invoice/);
  });

  test("two parallel withdrawals cannot spend the same balance", async () => {
    await deposit(10_000);
    const results = await Promise.all([withdraw(ln.externalInvoice(6000)), withdraw(ln.externalInvoice(6000))]);
    const ok = results.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    expect((await call<AccountState>("GET", "/api/me")).data.balance).toBe(10_000 - 6000 - 1);
  });
});
