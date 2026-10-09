const int = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = Number(raw);
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${name} must be a whole number, 0 or more`);
  return v;
};

export interface Config {
  port: number;
  databasePath: string;
  /** "fake" or "lnd" */
  lnBackend: string;
  lnd: {
    restUrl: string;
    macaroonPath: string;
    tlsCertPath: string;
  };
  minBet: number;
  maxBet: number;
  minDeposit: number;
  maxDeposit: number;
  depositExpirySeconds: number;
  maxWithdrawal: number;
  /** The fee reserve for a withdrawal is max(base, ceil(amount * ppm / 1e6)). */
  withdrawalFeeBase: number;
  withdrawalFeePpm: number;
  withdrawalTimeoutSeconds: number;
  invoiceMemo: string;
}

export function loadConfig(): Config {
  return {
    port: int("PORT", 3000),
    databasePath: process.env.DATABASE_PATH ?? "data/ln-craps.sqlite",
    lnBackend: process.env.LN_BACKEND ?? "fake",
    lnd: {
      restUrl: process.env.LND_REST_URL ?? "https://127.0.0.1:8080",
      macaroonPath: process.env.LND_MACAROON_PATH ?? "",
      tlsCertPath: process.env.LND_TLS_CERT_PATH ?? "",
    },
    minBet: int("MIN_BET", 1),
    maxBet: int("MAX_BET", 100_000),
    minDeposit: int("MIN_DEPOSIT", 1),
    maxDeposit: int("MAX_DEPOSIT", 1_000_000),
    depositExpirySeconds: int("DEPOSIT_EXPIRY_SECONDS", 600),
    maxWithdrawal: int("MAX_WITHDRAWAL", 1_000_000),
    withdrawalFeeBase: int("WITHDRAWAL_FEE_BASE", 10),
    withdrawalFeePpm: int("WITHDRAWAL_FEE_PPM", 5_000),
    withdrawalTimeoutSeconds: int("WITHDRAWAL_TIMEOUT_SECONDS", 60),
    invoiceMemo: process.env.INVOICE_MEMO ?? "ln-craps deposit",
  };
}
