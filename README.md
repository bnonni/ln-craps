# ln-craps

Provably fair craps with Bitcoin Lightning Network deposits and withdrawals. No registration.

The model is [Lightning Roulette](https://github.com/igreshev/lightning-roulette) (MIT):

- An anonymous account holds a balance in sats.
- A deposit is a Lightning invoice from the server.
- A withdrawal is a BOLT11 invoice that the player pastes.
- Each player has a private table. A roll is instant.

## Quick start

```sh
bun install
bun run dev        # API on :3000, UI on http://localhost:5173
```

The default Lightning backend is `fake`. It moves no real money. In the deposit and withdraw windows, use the dev buttons to simulate a payment.

Other commands:

| Command | Action |
| --- | --- |
| `bun test` | Run the tests (engine, fairness, API, payments) |
| `bun run typecheck` | Type check all code |
| `bun run build` | Build the UI to `dist/` |
| `bun run start` | Start the server in production mode. It also serves `dist/`. |

## Provably fair

1. Before you bet, the server shows `SHA-256(serverSeed)`.
2. You set a `clientSeed`. The server cannot choose a seed that gives bad rolls for your seed.
3. For roll `nonce` (0, 1, 2, ...), the server calculates `HMAC-SHA512(key = serverSeed, message = "clientSeed:nonce:0")`.
4. The server reads the bytes in order and rejects each byte from 252 to 255. Each other byte gives a die: `byte % 6 + 1`. The first two dice are the roll. Thus each face has a probability of exactly 1/6.
5. When you rotate the seeds, the server shows the old `serverSeed`. The browser verifies each old roll.

To verify a roll without this code:

```sh
echo -n "$SERVER_SEED" | sha256sum                                   # must equal the hash shown before play
echo -n "$CLIENT_SEED:$NONCE:0" | openssl dgst -sha512 -hmac "$SERVER_SEED"
```

The full procedure is in `src/shared/fair.ts`. The tests compare the server code, the browser code, and vectors from `openssl`.

## Bets

| Bet | Pays | House edge |
| --- | --- | --- |
| Pass Line, Come | 1 to 1 | 1.41% |
| Don't Pass, Don't Come (12 is a push) | 1 to 1 | 1.36% |
| Pass and Come Odds (3-4-5x) | 2:1, 3:2, 6:5 | 0% |
| Don't Pass and Don't Come Odds (6x) | 1:2, 2:3, 5:6 | 0% |
| Place 6, 8 | 7 to 6 | 1.52% |
| Place 5, 9 | 7 to 5 | 4.00% |
| Place 4, 10 | 9 to 5 | 6.67% |
| Field (2 pays 2x, 12 pays 3x) | 1 to 1 | 2.78% |

The tests calculate each house edge exactly from the engine.

Rules:

- A bet that pays a fraction must be a multiple of its unit (for example, Place 6 in multiples of 6). Thus each payout is a whole number of sats, and the house keeps no rounding.
- Pass Line and Don't Pass are fixed after the point is set.
- Place bets and Come odds are off on a come-out roll.
- A winning Pass Line, Place, or Field bet stays on the table. Only the win goes to the balance.

## Lightning (LND)

1. Make a macaroon with only the permissions that the server needs:
   `lncli bakemacaroon invoices:read invoices:write offchain:read offchain:write --save_to craps.macaroon`
2. Copy `.env.example` to `.env`.
3. Set `LN_BACKEND=lnd`, `LND_REST_URL`, `LND_MACAROON_PATH`, and `LND_TLS_CERT_PATH`.

Payment safety:

- A withdrawal takes the amount plus a fee reserve from the balance before the payment starts. After the payment, the server returns the unused part of the reserve.
- If the result of a payment is unknown (for example, a timeout or a restart), the funds stay reserved. A reconciler asks LND every 15 seconds. It refunds only if LND reports that the payment failed or that LND never started it.
- An account can have only one pending withdrawal.

## Layout

```
src/shared/craps.ts       rules engine (server and browser)
src/shared/fair.ts        provably fair dice (Web Crypto, used to verify in the browser)
src/shared/api.ts         HTTP API types
src/server/casino.ts      balances, rolls, deposits, withdrawals (SQLite transactions)
src/server/app.ts         Hono routes
src/server/lightning/     LightningBackend interface, fake backend, LND REST adapter
src/web/                  React UI (Vite)
test/                     bun tests
```

## Status

This is a first version. Before real money:

- Test the LND adapter against a node on regtest or signet. The tests use only the fake backend.
- Add rate limits for account and deposit requests.
- Get legal advice. Real-money gambling needs a license in most jurisdictions.
