// Typed client for the HTTP API in ../shared/api.ts.

import type {
  AccountState,
  CreateAccountResponse,
  DepositResponse,
  DevInvoiceResponse,
  RollResponse,
  RollsResponse,
  RotateSeedResponse,
  SetTableResponse,
  WithdrawalResponse,
} from "../shared/api";
import type { Layout } from "../shared/craps";

const TOKEN_KEY = "ln-craps-token";
const PREVIOUS_TOKEN_KEY = "ln-craps-token-previous";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);

/** Store a new key. The old key goes to a second slot, so a replaced key is not lost. */
export function saveToken(token: string): void {
  const old = getToken();
  if (old && old !== token) localStorage.setItem(PREVIOUS_TOKEN_KEY, old);
  localStorage.setItem(TOKEN_KEY, token);
}

interface Options {
  body?: unknown;
  auth?: boolean;
  token?: string;
}

async function request<T>(method: string, path: string, { body, auth = true, token }: Options = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const bearer = token ?? (auth ? getToken() : null);
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (res.ok) throw new ApiError("The server sent a response that is not JSON.", res.status);
  }
  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `Request failed with HTTP ${res.status}.`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

export const api = {
  createAccount: () => request<CreateAccountResponse>("POST", "/api/accounts", { auth: false }),
  me: (token?: string) => request<AccountState>("GET", "/api/me", { token }),
  setTable: (layout: Layout) => request<SetTableResponse>("PUT", "/api/table", { body: { layout } }),
  roll: (layout?: Layout) => request<RollResponse>("POST", "/api/roll", { body: layout ? { layout } : {} }),
  rolls: (limit = 50) => request<RollsResponse>("GET", `/api/rolls?limit=${limit}`),
  rotateSeed: (clientSeed: string) => request<RotateSeedResponse>("POST", "/api/seeds/rotate", { body: { clientSeed } }),
  createDeposit: (amount: number) => request<DepositResponse>("POST", "/api/deposits", { body: { amount } }),
  getDeposit: (paymentHash: string) =>
    request<DepositResponse>("GET", `/api/deposits/${encodeURIComponent(paymentHash)}`),
  createWithdrawal: (bolt11: string) => request<WithdrawalResponse>("POST", "/api/withdrawals", { body: { bolt11 } }),
  getWithdrawal: (paymentHash: string) =>
    request<WithdrawalResponse>("GET", `/api/withdrawals/${encodeURIComponent(paymentHash)}`),
  devPayDeposit: (paymentHash: string) =>
    request<DepositResponse>("POST", `/api/dev/deposits/${encodeURIComponent(paymentHash)}/pay`),
  devInvoice: (amount: number) => request<DevInvoiceResponse>("POST", "/api/dev/invoices", { body: { amount } }),
};

let loading: Promise<AccountState> | null = null;

/** Load the stored account. If there is no key, or the server does not know the key, make a new account. */
export function ensureAccount(): Promise<AccountState> {
  loading ??= (async () => {
    if (getToken()) {
      try {
        return await api.me();
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) throw e;
      }
    }
    const { token, account } = await api.createAccount();
    saveToken(token);
    return account;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
