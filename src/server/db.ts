import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// All times are Unix epoch milliseconds. All amounts are sats.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  balance     INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  table_state TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS seeds (
  id               INTEGER PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts(id),
  server_seed      TEXT NOT NULL,
  server_seed_hash TEXT NOT NULL,
  client_seed      TEXT NOT NULL,
  next_nonce       INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  revealed_at      INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS seeds_active ON seeds(account_id) WHERE revealed_at IS NULL;

CREATE TABLE IF NOT EXISTS rolls (
  id            INTEGER PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  seed_id       INTEGER NOT NULL REFERENCES seeds(id),
  nonce         INTEGER NOT NULL,
  die1          INTEGER NOT NULL,
  die2          INTEGER NOT NULL,
  point_before  INTEGER,
  event         TEXT,
  results       TEXT NOT NULL,
  net           INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE (seed_id, nonce)
);
CREATE INDEX IF NOT EXISTS rolls_account ON rolls(account_id, id);

CREATE TABLE IF NOT EXISTS deposits (
  payment_hash TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  bolt11       TEXT NOT NULL,
  amount       INTEGER NOT NULL,
  amount_paid  INTEGER,
  state        TEXT NOT NULL CHECK (state IN ('pending', 'settled', 'expired')),
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  settled_at   INTEGER
);
CREATE INDEX IF NOT EXISTS deposits_pending ON deposits(state) WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS withdrawals (
  payment_hash TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  bolt11       TEXT NOT NULL,
  amount       INTEGER NOT NULL,
  fee_reserve  INTEGER NOT NULL,
  fee          INTEGER,
  state        TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed')),
  preimage     TEXT,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS withdrawals_pending ON withdrawals(state) WHERE state = 'pending';
`;

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}

export interface AccountRow {
  id: string;
  balance: number;
  table_state: string;
}

export interface SeedRow {
  id: number;
  account_id: string;
  server_seed: string;
  server_seed_hash: string;
  client_seed: string;
  next_nonce: number;
  revealed_at: number | null;
}

export interface RollRow {
  id: number;
  nonce: number;
  die1: number;
  die2: number;
  point_before: number | null;
  event: string | null;
  results: string;
  net: number;
  balance_after: number;
  created_at: number;
  server_seed_hash: string;
  client_seed: string;
  server_seed: string;
  revealed_at: number | null;
}

export interface DepositRow {
  payment_hash: string;
  account_id: string;
  bolt11: string;
  amount: number;
  amount_paid: number | null;
  state: "pending" | "settled" | "expired";
  expires_at: number;
}

export interface WithdrawalRow {
  payment_hash: string;
  account_id: string;
  bolt11: string;
  amount: number;
  fee_reserve: number;
  fee: number | null;
  state: "pending" | "succeeded" | "failed";
  error: string | null;
  created_at: number;
}
