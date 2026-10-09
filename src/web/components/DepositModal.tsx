import QRCode from "qrcode";
import { useEffect, useState } from "react";
import type { DepositResponse } from "../../shared/api";
import { api, errorText } from "../api";
import { sats } from "../betting";
import { copy, Modal } from "./Modal";

declare global {
  interface Window {
    webln?: { enable(): Promise<void>; sendPayment(paymentRequest: string): Promise<unknown> };
  }
}

interface Props {
  backend: string;
  onBalance: (balance: number) => void;
  onClose: () => void;
}

export function DepositModal({ backend, onBalance, onClose }: Props) {
  const [amount, setAmount] = useState("1000");
  const [deposit, setDeposit] = useState<DepositResponse | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const hash = deposit?.paymentHash;
  const pending = deposit?.state === "pending";

  useEffect(() => {
    if (!deposit) return;
    QRCode.toDataURL(`lightning:${deposit.bolt11}`.toUpperCase(), { margin: 1, width: 280 })
      .then(setQr)
      .catch((e: unknown) => setError(errorText(e)));
  }, [deposit?.bolt11]);

  useEffect(() => {
    if (!hash || !pending) return;
    const timer = setInterval(async () => {
      try {
        const next = await api.getDeposit(hash);
        setDeposit(next);
        if (next.state === "settled") onBalance(next.balance);
      } catch (e) {
        setError(errorText(e));
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [hash, pending, onBalance]);

  async function create() {
    const value = Number(amount);
    if (!Number.isSafeInteger(value) || value <= 0) {
      setError("The amount must be a whole number of sats, more than 0.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setDeposit(await api.createDeposit(value));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function payWithWebln() {
    if (!deposit || !window.webln) return;
    setError(null);
    try {
      await window.webln.enable();
      await window.webln.sendPayment(deposit.bolt11);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function simulate() {
    if (!deposit) return;
    setError(null);
    try {
      const next = await api.devPayDeposit(deposit.paymentHash);
      setDeposit(next);
      if (next.state === "settled") onBalance(next.balance);
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <Modal title="Deposit" onClose={onClose}>
      {!deposit && (
        <form
          className="stack-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label>
            Amount (sats)
            <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.trim())} autoFocus />
          </label>
          <button type="submit" disabled={busy}>
            Make invoice
          </button>
        </form>
      )}

      {deposit && (
        <div className="invoice">
          <p>
            Pay this invoice to add <b>{sats(deposit.amount)}</b> to your balance.
          </p>
          {qr && <img className="qr" src={qr} alt="Lightning invoice QR code" />}
          <textarea readOnly value={deposit.bolt11} rows={4} onFocus={(e) => e.target.select()} />
          <div className="row">
            <button
              type="button"
              onClick={() =>
                copy(deposit.bolt11).then(
                  () => setCopied(true),
                  (e: unknown) => setError(errorText(e)),
                )
              }
            >
              {copied ? "Copied" : "Copy invoice"}
            </button>
            {pending && window.webln && (
              <button type="button" onClick={() => void payWithWebln()}>
                Pay with WebLN
              </button>
            )}
            {pending && backend === "fake" && (
              <button type="button" className="dev" onClick={() => void simulate()}>
                Simulate payment (dev)
              </button>
            )}
          </div>
          <p className={`status ${deposit.state}`}>
            {deposit.state === "pending" && "Wait for payment. This window updates every 2 seconds."}
            {deposit.state === "settled" && `Paid. Your balance is now ${sats(deposit.balance)}.`}
            {deposit.state === "expired" && "The invoice expired. Make a new invoice."}
          </p>
          {deposit.state !== "pending" && (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setDeposit(null);
                setQr(null);
                setCopied(false);
              }}
            >
              New deposit
            </button>
          )}
        </div>
      )}

      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}
