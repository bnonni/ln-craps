import { useCallback, useEffect, useMemo, useState } from "react";
import type { AccountState, Fairness, RevealedSeed, RollRecord } from "../shared/api";
import { applyLayout, emptyLayout, layoutOf, stakeOf, type Dice, type Layout, type Table as TableState } from "../shared/craps";
import { api, ApiError, ensureAccount, errorText, saveToken } from "./api";
import { compact, sameLayout, sats } from "./betting";
import { AccountPanel } from "./components/AccountPanel";
import { DepositModal } from "./components/DepositModal";
import { DicePanel } from "./components/Dice";
import { FairPanel } from "./components/FairPanel";
import { Table } from "./components/Table";
import { WithdrawModal } from "./components/WithdrawModal";

const CHIPS = [1, 10, 100, 1_000, 10_000];
const ROLL_MS = 600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomDie = () => 1 + Math.floor(Math.random() * 6);

export function App() {
  const [account, setAccount] = useState<AccountState | null>(null);
  const [draft, setDraft] = useState<Layout>(emptyLayout);
  const [rolls, setRolls] = useState<RollRecord[]>([]);
  const [lastRoll, setLastRoll] = useState<RollRecord | null>(null);
  const [shownDice, setShownDice] = useState<Dice | null>(null);
  const [rolling, setRolling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [chip, setChip] = useState(10);
  const [modal, setModal] = useState<"deposit" | "withdraw" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshRolls = useCallback(() => {
    api.rolls(50).then(
      (r) => setRolls(r.rolls),
      (e: unknown) => setError(errorText(e)),
    );
  }, []);

  const showAccount = useCallback(
    (a: AccountState) => {
      setAccount(a);
      setDraft(layoutOf(a.table));
      setLastRoll(null);
      setShownDice(null);
      refreshRolls();
    },
    [refreshRolls],
  );

  const load = useCallback(() => {
    ensureAccount().then(showAccount, (e: unknown) => setError(errorText(e)));
  }, [showAccount]);

  useEffect(load, [load]);

  const fail = useCallback(
    (e: unknown) => {
      setError(errorText(e));
      if (e instanceof ApiError && e.status === 401) load();
    },
    [load],
  );

  const setTableState = (table: TableState, balance: number, fairness?: Fairness) => {
    setAccount((a) => (a ? { ...a, table, balance, fairness: fairness ?? a.fairness } : a));
    setDraft(layoutOf(table));
  };

  const onBalance = useCallback((balance: number) => setAccount((a) => (a ? { ...a, balance } : a)), []);
  const closeModal = useCallback(() => setModal(null), []);

  const check = useMemo(() => {
    if (!account) return { cost: 0, error: null };
    try {
      return { cost: applyLayout(account.table, draft, account.limits).cost, error: null };
    } catch (e) {
      return { cost: 0, error: errorText(e) };
    }
  }, [account, draft]);

  if (!account) {
    return (
      <div className="app loading">
        <h1>Lightning Craps</h1>
        {error ? <p className="error-text">{error}</p> : <p className="muted">Load account...</p>}
      </div>
    );
  }

  const changed = !sameLayout(draft, layoutOf(account.table));
  const draftStake = stakeOf(account.table) + check.cost;
  const tooMuch = check.cost > account.balance;
  const canRoll = !rolling && !saving && !check.error && !tooMuch && (draftStake > 0 || stakeOf(account.table) > 0);

  async function roll() {
    setRolling(true);
    setError(null);
    const animation = setInterval(() => setShownDice([randomDie(), randomDie()]), 80);
    try {
      const [res] = await Promise.all([api.roll(draft), sleep(ROLL_MS)]);
      clearInterval(animation);
      setShownDice(res.roll.dice);
      setLastRoll(res.roll);
      setTableState(res.table, res.balance, res.fairness);
      refreshRolls();
    } catch (e) {
      clearInterval(animation);
      setShownDice(lastRoll?.dice ?? null);
      fail(e);
    } finally {
      setRolling(false);
    }
  }

  async function saveBets() {
    setSaving(true);
    setError(null);
    try {
      const res = await api.setTable(draft);
      setTableState(res.table, res.balance);
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  }

  async function loadKey(token: string) {
    try {
      const a = await api.me(token);
      saveToken(token);
      showAccount(a);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? "The server does not know this key." : errorText(e));
    }
  }

  function onRotated(fairness: Fairness, previousSeed: RevealedSeed) {
    setAccount((a) => (a ? { ...a, fairness, previousSeed } : a));
    refreshRolls();
  }

  const point = account.table.point;

  return (
    <div className="app">
      <header className="top">
        <h1>
          <span className="bolt">⚡</span> Lightning Craps
        </h1>
        <div className="wallet">
          <div className="balance">
            <span className="muted">Balance</span>
            <b>{sats(account.balance)}</b>
          </div>
          <div className="balance">
            <span className="muted">On table</span>
            <b>{sats(stakeOf(account.table))}</b>
          </div>
          <button type="button" onClick={() => setModal("deposit")}>
            Deposit
          </button>
          <button type="button" className="secondary" onClick={() => setModal("withdraw")}>
            Withdraw
          </button>
        </div>
      </header>

      {error && (
        <div className="banner" role="alert">
          <span>{error}</span>
          <button type="button" className="ghost" onClick={() => setError(null)} aria-label="Close the error">
            ✕
          </button>
        </div>
      )}

      <main className="layout">
        <div className="play">
          <div className="phase">
            {point === null ? "Come-out roll. The puck is OFF." : `The point is ${point}. The puck is ON.`}
            <span className="muted">
              {" "}
              Bets: {account.limits.minBet} to {compact(account.limits.maxBet)} sats.
            </span>
          </div>

          <Table table={account.table} draft={draft} limits={account.limits} chip={chip} locked={rolling || saving} onChange={setDraft} />

          <div className="controls">
            <div className="chips" role="radiogroup" aria-label="Chip value">
              {CHIPS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={chip === c}
                  className={`chip-pick${chip === c ? " active" : ""}`}
                  onClick={() => setChip(c)}
                >
                  {compact(c)}
                </button>
              ))}
            </div>
            <p className="muted help">Click a spot to add a chip. Right click or Shift+click to remove a chip.</p>
            <div className="cost">
              <span>
                Bet change:{" "}
                <b className={check.cost > 0 ? "lose" : check.cost < 0 ? "win" : ""}>
                  {check.cost > 0 ? "+" : ""}
                  {sats(check.cost)}
                </b>
              </span>
              {tooMuch && <span className="error-text">Your balance is too low for these bets.</span>}
              {check.error && <span className="error-text">{check.error}</span>}
            </div>
            <div className="row">
              <button type="button" className="ghost" disabled={!changed || rolling || saving} onClick={() => setDraft(layoutOf(account.table))}>
                Clear
              </button>
              <button
                type="button"
                className="secondary"
                disabled={!changed || rolling || saving || !!check.error || tooMuch}
                onClick={() => void saveBets()}
              >
                Set bets
              </button>
              <button type="button" className="roll" disabled={!canRoll} onClick={() => void roll()}>
                Roll
              </button>
            </div>
          </div>

          <DicePanel shown={shownDice} rolling={rolling} last={lastRoll} />
        </div>

        <aside className="side">
          <FairPanel
            fairness={account.fairness}
            previousSeed={account.previousSeed}
            rolls={rolls}
            onRotated={onRotated}
            onError={setError}
          />
          <AccountPanel accountId={account.id} onLoadKey={loadKey} onError={setError} />
        </aside>
      </main>

      {modal === "deposit" && <DepositModal backend={account.backend} onBalance={onBalance} onClose={closeModal} />}
      {modal === "withdraw" && (
        <WithdrawModal backend={account.backend} balance={account.balance} onBalance={onBalance} onClose={closeModal} />
      )}
    </div>
  );
}
