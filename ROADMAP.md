# ln-craps roadmap: from v1 to live with real users

Status on 2026-10-08:

- v1 works with the fake Lightning backend. `bun test` gives 37 pass, 0 fail.
- The repo has no commits.
- No code ran against a real LND node.

## How to read this roadmap

- Each phase has a goal, tasks, an estimate, and an exit gate.
- Do the phases in order. Exception: start Phase 4 (legal) now, in parallel. It has the longest lead time.
- Estimates are for one developer with Claude Code. They do not include the wait time for third parties.
- **(decision)** marks a task that needs a choice from the owner before work starts.

## Critical path

| Phase | Goal | Estimate | Exit gate |
| --- | --- | --- | --- |
| 0. Lock the base | Code in git, CI green | 1 hour | CI passes on `main` |
| 1. Real Lightning | Deposits and withdrawals work on regtest | 1 to 2 days | LND integration test passes in CI |
| 2. Security | Server resists common attacks | 2 to 3 days | Security review finds no high issue |
| 3. Money safety | Operator sees the money and can stop the game | 2 to 3 days | Ledger invariant test passes |
| 4. Legal and business | Legal basis for real money | 2 to 6 months (parallel) | License or written legal opinion |
| 5. Infrastructure | Production hosts, backups, alerts | 3 to 5 days | Full stack runs on signet |
| 6. Product for players | Players understand the game and keep the key | 3 to 4 days | A new player finishes a session without help |
| 7. Pre-launch checks | Proof that the system is safe | 2 to 3 weeks (mostly wait time) | No open high issue, restore drill passes |
| 8. Launch | Real players with low risk | 2 weeks soft launch, then public | Limits raised, public announcement |

Totals:

- Code work: about 3 to 4 weeks.
- Beta and soft launch: about 4 more weeks.
- Legal: 2 to 6 months, in parallel. This estimate has high uncertainty. It depends on the jurisdiction.
- The real-money launch waits for the longer of the code track and the legal track.

## Decisions that block work

1. **Jurisdiction and license.** This decision also sets KYC. Most gambling licenses require identity checks (KYC) above a threshold. KYC conflicts with the "no registration" design.
2. **Withdrawal policy.** Can a player withdraw a deposit without a bet? If yes, the casino is a free payment relay for money laundering. Options: a wager requirement, or a fee on an early withdrawal.
3. **LND host.** A hosted node (for example, Voltage) or your own server.
4. **Bankroll size.** It sets `MAX_BET` and the maximum payout for each roll.
5. **Domain name and brand.**

## Phase 0: Lock the base (1 hour)

Goal: the v1 code is safe in git, and CI runs the tests on each push.

- [ ] Run `bun run dev`. Play 20 rolls after a fake deposit. Make sure that the balance is correct.
- [ ] Make the first commit. Create the remote repo **(decision: name, public or private)**.
- [ ] Add a CI workflow (GitHub Actions): `bun install`, `bun test`, `bun run typecheck`, `bun run build`.
- [ ] Add Renovate or Dependabot for dependency updates.

Exit gate: CI passes on `main`.

## Phase 1: Real Lightning on regtest (1 to 2 days)

Goal: deposits and withdrawals work with a real LND node, and each failure path is safe.

- [ ] Start a regtest network in Polar: one node for the casino, two nodes for players.
- [ ] Set `LN_BACKEND=lnd`. Do a deposit, a withdrawal, and an expired invoice. Make sure that each balance is correct.
- [ ] Test the failure paths: no route, LND restart in a payment, app restart in a payment. The reconciler must refund only a failed payment.
- [ ] Fix the bugs in `src/server/lightning/lnd.ts`. Keep each real LND response as a test fixture.
- [ ] Add an automated integration test: Docker Compose with `bitcoind` and two LND nodes. CI runs it each night.

Exit gate: the LND integration test passes in CI.

## Phase 2: Security fixes (2 to 3 days)

Goal: the server resists common attacks on a money app.

- [ ] Add rate limits for each IP address on `POST /api/accounts`, `/api/deposits`, `/api/withdrawals`, and `/api/roll`. Read the client IP only from a trusted proxy header.
- [ ] Add security headers to each response: a strict `Content-Security-Policy`, HSTS, `X-Frame-Options: DENY`, `Referrer-Policy`. Reason: the account key is in `localStorage`, so an XSS attack steals the account.
- [ ] Limit the HTLC lock time for withdrawals: set `cltv_limit` in `SendPaymentV2`. Without a limit, a hold invoice can lock casino liquidity for days.
- [ ] Add a production config guard. The server must refuse to start with `LN_BACKEND=fake` if `NODE_ENV=production`.
- [ ] Add schema migrations: a version number (`PRAGMA user_version`) and ordered migration files. After launch, each schema change touches real balances.

Exit gate: `/security-review` finds no high-severity issue.

## Phase 3: Money safety and operator tools (2 to 3 days)

Goal: the operator can see the money, stop the game, and limit losses.

- [ ] Add `MAX_PAYOUT_PER_ROLL` **(decision: bankroll size)**. The server rejects a layout if its maximum win on one roll is more than this value.
- [ ] Add a solvency check. A background job compares the sum of player balances with the funds in LND. It sends an alert below a set ratio.
- [ ] Add a ledger check. The sum of all balances must equal deposits, minus withdrawals and fees, plus the net result of all rolls.
- [ ] Add a pause switch. It stops new deposits and new rolls. Withdrawals stay open.
- [ ] Add an operator CLI (`bun run admin`): liabilities, pending withdrawals, large wins, and the pause switch.

Exit gate: a test proves the ledger invariant after 10,000 random rolls, deposits, and withdrawals.

## Phase 4: Legal and business (start now, 2 to 6 months, in parallel)

Goal: a legal basis to accept real money. This phase blocks the real-money launch.

This roadmap is not legal advice. A gambling lawyer must confirm each item.

- [ ] Get advice from a gambling lawyer. Choose the jurisdiction and the license type **(decision)**.
- [ ] Form a legal entity in that jurisdiction. Get an accountant and a plan for gambling tax.
- [ ] Write the Terms of Service, the Privacy Policy, the AML policy, and the Responsible Gambling policy (18+, self-exclusion, deposit limits).
- [ ] Get the list of blocked countries from the lawyer. It usually includes countries with their own license system (for example, the US and the UK).
- [ ] If the license requires KYC: choose a KYC provider. Add a Phase 3b for the KYC integration (1 to 2 weeks).

Exit gate: a license, or a written legal opinion for the target market.

## Phase 5: Production infrastructure (3 to 5 days, plus channel costs)

Goal: the app and the LND node run on production hosts, with backups and alerts.

- [ ] Set up the LND node **(decision: hosted or own server)** on a different host from the app. Open channels to well-connected nodes. Buy inbound liquidity from an LSP (for example, Amboss Magma), so that players can deposit.
- [ ] Limit the hot wallet. Keep in channels only the funds that withdrawals need. Move the surplus to cold storage on a schedule (for example, with Loop Out). Reason: the macaroon can send payments, so a server breach can empty the node.
- [ ] Set up the app host: a Docker image, Caddy for TLS, a domain **(decision)**, and Cloudflare for DDoS protection and country blocks. Make sure that the terms of the host permit a gambling site.
- [ ] Set up backups. Litestream copies SQLite to S3-compatible storage without a stop. Encrypt the backups, because the database holds unrevealed server seeds. Keep the LND seed offline. Copy `channel.backup` off the host after each channel change.
- [ ] Set up alerts: a `/healthz` endpoint, an uptime check, and JSON logs. Alert on: LND down, a withdrawal pending for more than 10 minutes, a solvency alert, a spike in 5xx errors.

Exit gate: the full stack runs on signet on the production hosts.

## Phase 6: Product for real players (3 to 4 days)

Goal: a new player understands the game and the risks, and keeps the account key.

- [ ] Key backup: before the first deposit, show the account key. The player must confirm a backup. A lost key means lost funds.
- [ ] Add pages: How to Play, Provably Fair (with the `openssl` steps), Terms, Privacy, Responsible Gambling, Support contact.
- [ ] Add an age and country gate on the first visit (18+, not a blocked country).
- [ ] Check the layout on a small screen (360 px wide). Check keyboard access and color contrast.
- [ ] Add end-to-end tests in Playwright: new account, deposit, bets, roll, seed rotation, verification, withdrawal. CI runs them with the fake backend.

Exit gate: a person new to craps finishes a full session without help.

## Phase 7: Pre-launch checks (2 to 3 weeks, mostly wait time)

Goal: proof that the system is safe before real money goes in.

- [ ] Get an external security review from a firm or a researcher with Lightning experience. Get two quotes.
- [ ] Do a load test on the roll and deposit endpoints (for example, with k6). Find the maximum rolls per second on the production host.
- [ ] Run a closed beta on signet for 1 to 2 weeks, with 10 to 20 invited testers.
- [ ] Do a restore drill on signet: restore the database and the LND node from backup on a new host. Measure the time. Do not do this drill on mainnet, because a `channel.backup` restore closes all channels.
- [ ] Write an incident runbook: who acts, how to pause the game, how to tell the players.

Exit gate: no open high-severity or medium-severity issue, and the restore drill passes.

## Phase 8: Launch (2 weeks soft launch, then public)

Goal: real players and real money, with low risk.

- [ ] Start a mainnet soft launch with no public announcement. Use low limits (for example, `MAX_BET=1000`, `MAX_DEPOSIT=50000`) and a small hot wallet.
- [ ] Each day for 2 weeks, read the solvency check, the ledger check, and the pending withdrawals.
- [ ] Raise the limits in steps. Raise them only after one stable week of bankroll and alerts.
- [ ] Make the public announcement.

Exit gate: public launch.

## After launch (backlog)

- Hardways and one-roll proposition bets.
- LNURL-withdraw and Lightning Address withdrawals.
- LNURL-auth or Nostr login, as an alternative to the account key.
- A shared multiplayer table.
- A second Lightning backend (Core Lightning or Phoenixd) behind the adapter.
