// All balance changes happen here, each in one synchronous SQLite transaction.
// Bun runs JavaScript on one thread, so two requests cannot change one balance at the same time.

import type { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import type {
  AccountState,
  CreateAccountResponse,
  DepositResponse,
  Fairness,
  RevealedSeed,
  RollRecord,
  RollResponse,
  RotateSeedResponse,
  SetTableResponse,
  WithdrawalResponse,
} from "../shared/api";
import { applyLayout, emptyTable, resolveRoll, stakeOf, type Layout, type Limits, type Table } from "../shared/craps";
import type { Config } from "./config";
import type { AccountRow, DepositRow, RollRow, SeedRow, WithdrawalRow } from "./db";
import { newClientSeed, newServerSeed, rollDiceSync, sha256 } from "./fair";
import type { LightningBackend } from "./lightning";
import type { PaymentStatus } from "./lightning/types";

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 409 | 502,
    message: string,
  ) {
    super(message);
  }
}

const MAX_PENDING_DEPOSITS = 5;
/** A deposit invoice stays pending for this time after it expires, in case a payment is late. */
const DEPOSIT_GRACE_MS = 60_000;
/** The reconciler does not check a pending withdrawal that is younger than this. */
const WITHDRAWAL_RECONCILE_AGE_MS = 60_000;
const MIN_INVOICE_LIFETIME_MS = 30_000;
const CLIENT_SEED = /^[\x21-\x7e]{1,64}$/;

export class Casino {
  /** Withdrawals that wait for a payInvoice call in this process. The reconciler skips them. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly config: Config,
    readonly ln: LightningBackend,
  ) {}

  get limits(): Limits {
    return { minBet: this.config.minBet, maxBet: this.config.maxBet };
  }

  // Accounts

  createAccount(): CreateAccountResponse {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .query("INSERT INTO accounts (id, token_hash, table_state, created_at) VALUES ($id, $hash, $table, $now)")
        .run({ id, hash: sha256(token), table: JSON.stringify(emptyTable()), now });
      this.insertSeed(id, newClientSeed(), now);
    })();
    return { token, account: this.state(id) };
  }

  authenticate(token: string): string | null {
    const row = this.db.query("SELECT id FROM accounts WHERE token_hash = $hash").get({ hash: sha256(token) }) as {
      id: string;
    } | null;
    return row?.id ?? null;
  }

  state(accountId: string): AccountState {
    const account = this.account(accountId);
    return {
      id: account.id,
      balance: account.balance,
      table: JSON.parse(account.table_state) as Table,
      fairness: this.fairness(this.activeSeed(accountId)),
      previousSeed: this.previousSeed(accountId),
      limits: this.limits,
      backend: this.ln.name,
    };
  }

  private account(accountId: string): AccountRow {
    const row = this.db.query("SELECT id, balance, table_state FROM accounts WHERE id = $id").get({ id: accountId });
    if (!row) throw new HttpError(404, "Account not found.");
    return row as AccountRow;
  }

  private credit(accountId: string, amount: number): void {
    this.db.query("UPDATE accounts SET balance = balance + $amount WHERE id = $id").run({ id: accountId, amount });
  }

  // Seeds

  private insertSeed(accountId: string, clientSeed: string, now: number): void {
    const serverSeed = newServerSeed();
    this.db
      .query(
        `INSERT INTO seeds (account_id, server_seed, server_seed_hash, client_seed, created_at)
         VALUES ($accountId, $serverSeed, $hash, $clientSeed, $now)`,
      )
      .run({ accountId, serverSeed, hash: sha256(serverSeed), clientSeed, now });
  }

  private activeSeed(accountId: string): SeedRow {
    const row = this.db
      .query("SELECT * FROM seeds WHERE account_id = $accountId AND revealed_at IS NULL")
      .get({ accountId }) as SeedRow | null;
    if (!row) throw new Error(`account ${accountId} has no active seed`);
    return row;
  }

  private fairness(seed: SeedRow): Fairness {
    return { serverSeedHash: seed.server_seed_hash, clientSeed: seed.client_seed, nonce: seed.next_nonce };
  }

  private previousSeed(accountId: string): RevealedSeed | null {
    const row = this.db
      .query(
        `SELECT * FROM seeds WHERE account_id = $accountId AND revealed_at IS NOT NULL
         ORDER BY revealed_at DESC, id DESC LIMIT 1`,
      )
      .get({ accountId }) as SeedRow | null;
    if (!row) return null;
    return {
      serverSeed: row.server_seed,
      serverSeedHash: row.server_seed_hash,
      clientSeed: row.client_seed,
      rolls: row.next_nonce,
    };
  }

  rotateSeed(accountId: string, clientSeed: unknown): RotateSeedResponse {
    if (typeof clientSeed !== "string" || !CLIENT_SEED.test(clientSeed)) {
      throw new HttpError(400, "The client seed must be 1 to 64 visible ASCII characters, with no spaces.");
    }
    this.account(accountId);
    const now = Date.now();
    this.db.transaction(() => {
      this.db.query("UPDATE seeds SET revealed_at = $now WHERE account_id = $accountId AND revealed_at IS NULL").run({
        accountId,
        now,
      });
      this.insertSeed(accountId, clientSeed, now);
    })();
    return { fairness: this.fairness(this.activeSeed(accountId)), previousSeed: this.previousSeed(accountId)! };
  }

  // Game

  setTable(accountId: string, layout: unknown): SetTableResponse {
    return this.db.transaction(() => {
      const { balance, table } = this.applyLayout(this.account(accountId), layout);
      this.saveAccount(accountId, balance, table);
      return { balance, table };
    })();
  }

  private applyLayout(account: AccountRow, layout: unknown): { balance: number; table: Table } {
    if (typeof layout !== "object" || layout === null || Array.isArray(layout)) {
      throw new HttpError(400, "The layout must be an object.");
    }
    const current = JSON.parse(account.table_state) as Table;
    const { table, cost } = applyLayout(current, layout as Layout, this.limits);
    if (cost > account.balance) {
      throw new HttpError(400, `Your balance is too low. These bets need ${cost} sats more than the bets on the table.`);
    }
    return { balance: account.balance - cost, table };
  }

  private saveAccount(accountId: string, balance: number, table: Table): void {
    this.db
      .query("UPDATE accounts SET balance = $balance, table_state = $table WHERE id = $id")
      .run({ id: accountId, balance, table: JSON.stringify(table) });
  }

  roll(accountId: string, layout?: unknown): RollResponse {
    return this.db.transaction(() => {
      const account = this.account(accountId);
      let balance = account.balance;
      let table = JSON.parse(account.table_state) as Table;
      if (layout !== undefined) ({ balance, table } = this.applyLayout(account, layout));
      if (stakeOf(table) === 0) throw new HttpError(400, "Put a bet on the table before you roll.");

      const seed = this.activeSeed(accountId);
      const nonce = seed.next_nonce;
      const dice = rollDiceSync(seed.server_seed, seed.client_seed, nonce);
      const pointBefore = table.point;
      const resolution = resolveRoll(table, dice);
      balance += resolution.credit;
      const net = resolution.results.reduce((s, r) => s + (r.outcome === "lose" ? -r.stake : r.win), 0);
      const now = Date.now();

      this.saveAccount(accountId, balance, resolution.table);
      this.db.query("UPDATE seeds SET next_nonce = next_nonce + 1 WHERE id = $id").run({ id: seed.id });
      this.db
        .query(
          `INSERT INTO rolls (account_id, seed_id, nonce, die1, die2, point_before, event, results, net, balance_after, created_at)
           VALUES ($accountId, $seedId, $nonce, $die1, $die2, $pointBefore, $event, $results, $net, $balance, $now)`,
        )
        .run({
          accountId,
          seedId: seed.id,
          nonce,
          die1: dice[0],
          die2: dice[1],
          pointBefore,
          event: resolution.event,
          results: JSON.stringify(resolution.results),
          net,
          balance,
          now,
        });

      return {
        roll: {
          nonce,
          dice,
          serverSeedHash: seed.server_seed_hash,
          clientSeed: seed.client_seed,
          serverSeed: null,
          event: resolution.event,
          pointBefore,
          results: resolution.results,
          net,
          balance,
          createdAt: now,
        },
        balance,
        table: resolution.table,
        fairness: { ...this.fairness(seed), nonce: nonce + 1 },
      };
    })();
  }

  rolls(accountId: string, limit = 50): RollRecord[] {
    const rows = this.db
      .query(
        `SELECT r.*, s.server_seed_hash, s.client_seed, s.server_seed, s.revealed_at
         FROM rolls r JOIN seeds s ON s.id = r.seed_id
         WHERE r.account_id = $accountId ORDER BY r.id DESC LIMIT $limit`,
      )
      .all({ accountId, limit: Math.min(Math.max(1, Math.trunc(limit) || 50), 500) }) as RollRow[];
    return rows.map((r) => ({
      nonce: r.nonce,
      dice: [r.die1, r.die2],
      serverSeedHash: r.server_seed_hash,
      clientSeed: r.client_seed,
      serverSeed: r.revealed_at === null ? null : r.server_seed,
      event: r.event as RollRecord["event"],
      pointBefore: r.point_before,
      results: JSON.parse(r.results),
      net: r.net,
      balance: r.balance_after,
      createdAt: r.created_at,
    }));
  }

  // Deposits

  async createDeposit(accountId: string, amount: unknown): Promise<DepositResponse> {
    const { minDeposit, maxDeposit, depositExpirySeconds, invoiceMemo } = this.config;
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < minDeposit || amount > maxDeposit) {
      throw new HttpError(400, `The deposit must be a whole number from ${minDeposit} to ${maxDeposit} sats.`);
    }
    this.account(accountId);
    const pending = this.db
      .query("SELECT COUNT(*) AS n FROM deposits WHERE account_id = $accountId AND state = 'pending'")
      .get({ accountId }) as { n: number };
    if (pending.n >= MAX_PENDING_DEPOSITS) {
      throw new HttpError(409, `You have ${pending.n} open deposit invoices. Pay one or wait until they expire.`);
    }
    let invoice;
    try {
      invoice = await this.ln.createInvoice(amount, invoiceMemo, depositExpirySeconds);
    } catch (e) {
      console.error("[deposit] create invoice failed:", e);
      throw new HttpError(502, "The Lightning node did not make an invoice. Try again later.");
    }
    this.db
      .query(
        `INSERT INTO deposits (payment_hash, account_id, bolt11, amount, state, expires_at, created_at)
         VALUES ($hash, $accountId, $bolt11, $amount, 'pending', $expiresAt, $now)`,
      )
      .run({ hash: invoice.paymentHash, accountId, bolt11: invoice.bolt11, amount, expiresAt: invoice.expiresAt, now: Date.now() });
    return this.deposit(accountId, invoice.paymentHash);
  }

  deposit(accountId: string, paymentHash: string): DepositResponse {
    const row = this.db
      .query("SELECT * FROM deposits WHERE payment_hash = $paymentHash AND account_id = $accountId")
      .get({ paymentHash, accountId }) as DepositRow | null;
    if (!row) throw new HttpError(404, "Deposit not found.");
    return {
      paymentHash: row.payment_hash,
      bolt11: row.bolt11,
      amount: row.amount_paid ?? row.amount,
      state: row.state,
      expiresAt: row.expires_at,
      balance: this.account(accountId).balance,
    };
  }

  /** Ask the node about one pending deposit. Credit the account if the invoice is paid. */
  async checkDeposit(paymentHash: string): Promise<void> {
    const row = this.db
      .query("SELECT * FROM deposits WHERE payment_hash = $paymentHash AND state = 'pending'")
      .get({ paymentHash }) as DepositRow | null;
    if (!row) return;
    const status = await this.ln.lookupInvoice(paymentHash);
    this.db.transaction(() => {
      if (status.state === "settled") {
        const changed = this.db
          .query(
            `UPDATE deposits SET state = 'settled', amount_paid = $paid, settled_at = $now
             WHERE payment_hash = $paymentHash AND state = 'pending'`,
          )
          .run({ paymentHash, paid: status.amountPaid, now: Date.now() }).changes;
        if (changed === 1) this.credit(row.account_id, status.amountPaid);
      } else if (status.state === "canceled" || row.expires_at + DEPOSIT_GRACE_MS < Date.now()) {
        this.db
          .query("UPDATE deposits SET state = 'expired' WHERE payment_hash = $paymentHash AND state = 'pending'")
          .run({ paymentHash });
      }
    })();
  }

  async syncDeposits(): Promise<void> {
    const rows = this.db.query("SELECT payment_hash FROM deposits WHERE state = 'pending'").all() as {
      payment_hash: string;
    }[];
    for (const { payment_hash } of rows) {
      await this.checkDeposit(payment_hash).catch((e) => console.error("[deposit] check failed:", payment_hash, e));
    }
  }

  // Withdrawals

  feeReserve(amount: number): number {
    return Math.max(this.config.withdrawalFeeBase, Math.ceil((amount * this.config.withdrawalFeePpm) / 1_000_000));
  }

  async withdraw(accountId: string, input: unknown): Promise<WithdrawalResponse> {
    if (typeof input !== "string") throw new HttpError(400, "Paste a Lightning invoice.");
    const bolt11 = input.trim().replace(/^lightning:/i, "");
    if (bolt11 === "" || bolt11.length > 4000) throw new HttpError(400, "Paste a Lightning invoice.");
    this.account(accountId);

    let decoded;
    try {
      decoded = await this.ln.decodeInvoice(bolt11);
    } catch {
      throw new HttpError(400, "This is not a valid Lightning invoice.");
    }
    const { paymentHash, amount } = decoded;
    if (amount <= 0) throw new HttpError(400, "The invoice must have an amount.");
    if (decoded.hasMsatRemainder) throw new HttpError(400, "The invoice amount must be a whole number of sats.");
    if (amount > this.config.maxWithdrawal) {
      throw new HttpError(400, `The maximum withdrawal is ${this.config.maxWithdrawal} sats. Make more than one withdrawal.`);
    }
    if (decoded.expiresAt < Date.now() + MIN_INVOICE_LIFETIME_MS) {
      throw new HttpError(400, "The invoice is expired or expires in less than 30 seconds.");
    }
    if (this.db.query("SELECT 1 FROM deposits WHERE payment_hash = $paymentHash").get({ paymentHash })) {
      throw new HttpError(400, "This is a deposit invoice from this casino. Use an invoice from your wallet.");
    }

    const feeReserve = this.feeReserve(amount);
    this.db.transaction(() => {
      if (this.db.query("SELECT 1 FROM withdrawals WHERE payment_hash = $paymentHash").get({ paymentHash })) {
        throw new HttpError(409, "This invoice is already used.");
      }
      const busy = this.db
        .query("SELECT 1 FROM withdrawals WHERE account_id = $accountId AND state = 'pending'")
        .get({ accountId });
      if (busy) throw new HttpError(409, "Your last withdrawal is not finished. Wait, then try again.");
      const { balance } = this.account(accountId);
      if (balance < amount + feeReserve) {
        throw new HttpError(
          400,
          `Your balance is too low. You need ${amount + feeReserve} sats: ${amount} sats plus a fee reserve of ${feeReserve} sats. The unused fee reserve comes back.`,
        );
      }
      this.credit(accountId, -(amount + feeReserve));
      const now = Date.now();
      this.db
        .query(
          `INSERT INTO withdrawals (payment_hash, account_id, bolt11, amount, fee_reserve, state, created_at, updated_at)
           VALUES ($paymentHash, $accountId, $bolt11, $amount, $feeReserve, 'pending', $now, $now)`,
        )
        .run({ paymentHash, accountId, bolt11, amount, feeReserve, now });
    })();

    this.inFlight.add(paymentHash);
    let status: PaymentStatus;
    try {
      status = await this.ln.payInvoice({
        bolt11,
        paymentHash,
        maxFee: feeReserve,
        timeoutSeconds: this.config.withdrawalTimeoutSeconds,
      });
    } catch (e) {
      // The result is unknown. Keep the funds reserved. The reconciler finds the result later.
      console.error("[withdraw] pay invoice result unknown:", paymentHash, e);
      status = { status: "pending" };
    } finally {
      this.inFlight.delete(paymentHash);
    }
    this.finishWithdrawal(paymentHash, status);
    return this.withdrawal(accountId, paymentHash);
  }

  private finishWithdrawal(paymentHash: string, status: PaymentStatus): void {
    if (status.status === "pending") return;
    this.db.transaction(() => {
      const row = this.db
        .query("SELECT * FROM withdrawals WHERE payment_hash = $paymentHash AND state = 'pending'")
        .get({ paymentHash }) as WithdrawalRow | null;
      if (!row) return;
      const now = Date.now();
      if (status.status === "succeeded") {
        const fee = Math.min(status.fee, row.fee_reserve);
        if (status.fee > row.fee_reserve) console.error("[withdraw] fee is more than the reserve:", paymentHash, status.fee);
        this.credit(row.account_id, row.fee_reserve - fee);
        this.db
          .query(
            `UPDATE withdrawals SET state = 'succeeded', fee = $fee, preimage = $preimage, updated_at = $now
             WHERE payment_hash = $paymentHash`,
          )
          .run({ paymentHash, fee, preimage: status.preimage, now });
      } else {
        this.credit(row.account_id, row.amount + row.fee_reserve);
        this.db
          .query("UPDATE withdrawals SET state = 'failed', error = $error, updated_at = $now WHERE payment_hash = $paymentHash")
          .run({ paymentHash, error: status.reason, now });
      }
    })();
  }

  withdrawal(accountId: string, paymentHash: string): WithdrawalResponse {
    const row = this.db
      .query("SELECT * FROM withdrawals WHERE payment_hash = $paymentHash AND account_id = $accountId")
      .get({ paymentHash, accountId }) as WithdrawalRow | null;
    if (!row) throw new HttpError(404, "Withdrawal not found.");
    return {
      paymentHash: row.payment_hash,
      amount: row.amount,
      feeReserve: row.fee_reserve,
      fee: row.fee,
      state: row.state,
      error: row.error,
      balance: this.account(accountId).balance,
    };
  }

  /** Find the result of each old pending withdrawal, for example after a restart. */
  async syncWithdrawals(minAgeMs = WITHDRAWAL_RECONCILE_AGE_MS): Promise<void> {
    const rows = this.db
      .query("SELECT payment_hash, bolt11 FROM withdrawals WHERE state = 'pending' AND created_at <= $before")
      .all({ before: Date.now() - minAgeMs }) as { payment_hash: string; bolt11: string }[];
    for (const { payment_hash, bolt11 } of rows) {
      if (this.inFlight.has(payment_hash)) continue;
      try {
        this.finishWithdrawal(payment_hash, await this.ln.lookupPayment(payment_hash, bolt11));
      } catch (e) {
        console.error("[withdraw] lookup failed:", payment_hash, e);
      }
    }
  }
}
