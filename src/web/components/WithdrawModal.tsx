import { useEffect, useState } from "react";
import type { WithdrawalResponse } from "../../shared/api";
import { api, errorText } from "../api";
import { sats } from "../betting";
import { Modal } from "./Modal";

interface Props {
  backend: string;
  balance: number;
  onBalance: (balance: number) => void;
  onClose: () => void;
}

export function WithdrawModal({ backend, balance, onBalance, onClose }: Props) {
  const [bolt11, setBolt11] = useState("");
  const [testAmount, setTestAmount] = useState("1000");
  const [withdrawal, setWithdrawal] = useState<WithdrawalResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hash = withdrawal?.paymentHash;
  const pending = withdrawal?.state === "pending";

  useEffect(() => {
    if (!hash || !pending) return;
    const timer = setInterval(async () => {
      try {
        const next = await api.getWithdrawal(hash);
        setWithdrawal(next);
        onBalance(next.balance);
      } catch (e) {
        setError(errorText(e));
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [hash, pending, onBalance]);

  async function withdraw() {
    const invoice = bolt11.trim().replace(/^lightning:/i, "");
    if (!invoice) {
      setError("Paste a BOLT11 invoice.");
      return;
    }
    setBusy(true);
    setError(null);
    setWithdrawal(null);
    try {
      const result = await api.createWithdrawal(invoice);
      setWithdrawal(result);
      onBalance(result.balance);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function makeTestInvoice() {
    const value = Number(testAmount);
    if (!Number.isSafeInteger(value) || value <= 0) {
      setError("The amount must be a whole number of sats, more than 0.");
      return;
    }
    setError(null);
    try {
      setBolt11((await api.devInvoice(value)).bolt11);
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <Modal title="Withdraw" onClose={onClose}>
      <form
        className="stack-form"
        onSubmit={(e) => {
          e.preventDefault();
          void withdraw();
        }}
      >
        <p className="muted">
          Your balance is {sats(balance)}. Make an invoice in your wallet for the amount, then paste it here. The
          server keeps a fee reserve during the payment and gives back the part that it does not use.
        </p>
        <label>
          BOLT11 invoice
          <textarea rows={4} value={bolt11} onChange={(e) => setBolt11(e.target.value)} placeholder="lnbc..." />
        </label>
        {backend === "fake" && (
          <div className="row">
            <input
              className="small"
              inputMode="numeric"
              value={testAmount}
              onChange={(e) => setTestAmount(e.target.value.trim())}
              aria-label="Test invoice amount"
            />
            <button type="button" className="dev" onClick={() => void makeTestInvoice()}>
              Make test invoice (dev)
            </button>
          </div>
        )}
        <button type="submit" disabled={busy || pending}>
          Withdraw
        </button>
      </form>

      {withdrawal && (
        <dl className={`receipt ${withdrawal.state}`}>
          <dt>State</dt>
          <dd>{withdrawal.state}</dd>
          <dt>Amount</dt>
          <dd>{sats(withdrawal.amount)}</dd>
          <dt>Fee reserve</dt>
          <dd>{sats(withdrawal.feeReserve)}</dd>
          <dt>Fee</dt>
          <dd>{withdrawal.fee === null ? "not known yet" : sats(withdrawal.fee)}</dd>
          {withdrawal.error && (
            <>
              <dt>Error</dt>
              <dd>{withdrawal.error}</dd>
            </>
          )}
        </dl>
      )}

      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}
