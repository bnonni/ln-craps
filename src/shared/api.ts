// The HTTP API contract. All amounts are in sats.
// Auth: each request (except POST /api/accounts) sends `Authorization: Bearer <token>`.
// An error response is `{ error: string }` with a 4xx or 5xx status.

import type { BetResult, Dice, Layout, Limits, RollEvent, Table } from "./craps";

export interface Fairness {
  serverSeedHash: string;
  clientSeed: string;
  /** The nonce of the next roll. */
  nonce: number;
}

export interface RevealedSeed {
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  /** The number of rolls made with this seed pair. */
  rolls: number;
}

/** GET /api/me */
export interface AccountState {
  id: string;
  balance: number;
  table: Table;
  fairness: Fairness;
  previousSeed: RevealedSeed | null;
  limits: Limits;
  /** "fake" or "lnd". If "fake", the /api/dev routes exist. */
  backend: string;
}

/** POST /api/accounts -> 201 */
export interface CreateAccountResponse {
  token: string;
  account: AccountState;
}

/** PUT /api/table: set the bets without a roll. */
export interface SetTableRequest {
  layout: Layout;
}
export interface SetTableResponse {
  balance: number;
  table: Table;
}

/** POST /api/roll: optionally set the bets, then roll. */
export interface RollRequest {
  layout?: Layout;
}
export interface RollResponse {
  roll: RollRecord;
  balance: number;
  table: Table;
  fairness: Fairness;
}

export interface RollRecord {
  nonce: number;
  dice: Dice;
  serverSeedHash: string;
  clientSeed: string;
  /** Null until the player rotates the seed pair. */
  serverSeed: string | null;
  event: RollEvent;
  pointBefore: number | null;
  results: BetResult[];
  /** The total of the wins minus the total of the lost stakes. */
  net: number;
  balance: number;
  createdAt: number;
}

/** GET /api/rolls?limit=50 (newest first) */
export interface RollsResponse {
  rolls: RollRecord[];
}

/** POST /api/seeds/rotate */
export interface RotateSeedRequest {
  clientSeed: string;
}
export interface RotateSeedResponse {
  fairness: Fairness;
  previousSeed: RevealedSeed;
}

export type DepositState = "pending" | "settled" | "expired";

/** POST /api/deposits -> 201 */
export interface CreateDepositRequest {
  amount: number;
}
/** POST /api/deposits and GET /api/deposits/:paymentHash */
export interface DepositResponse {
  paymentHash: string;
  bolt11: string;
  amount: number;
  state: DepositState;
  expiresAt: number;
  balance: number;
}

export type WithdrawalState = "pending" | "succeeded" | "failed";

/** POST /api/withdrawals */
export interface CreateWithdrawalRequest {
  bolt11: string;
}
/** POST /api/withdrawals and GET /api/withdrawals/:paymentHash */
export interface WithdrawalResponse {
  paymentHash: string;
  amount: number;
  feeReserve: number;
  fee: number | null;
  state: WithdrawalState;
  error: string | null;
  balance: number;
}

/** Dev only (backend "fake"). POST /api/dev/deposits/:paymentHash/pay -> DepositResponse */
/** Dev only (backend "fake"). POST /api/dev/invoices { amount } -> { bolt11 } (an invoice to test a withdrawal) */
export interface DevInvoiceResponse {
  bolt11: string;
}

export interface ErrorResponse {
  error: string;
}
