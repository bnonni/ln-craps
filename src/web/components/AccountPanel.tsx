import { useState } from "react";
import { getToken } from "../api";
import { copy } from "./Modal";

interface Props {
  accountId: string;
  onLoadKey: (token: string) => Promise<void>;
  onError: (message: string) => void;
}

export function AccountPanel({ accountId, onLoadKey, onError }: Props) {
  const token = getToken() ?? "";
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <section className="panel account">
      <h2>Account</h2>
      <p className="muted">ID: {accountId}</p>
      <div className="row">
        <input readOnly type={show ? "text" : "password"} value={token} aria-label="Account key" onFocus={(e) => e.target.select()} />
        <button type="button" className="small" onClick={() => setShow((s) => !s)}>
          {show ? "Hide" : "Show"}
        </button>
        <button
          type="button"
          className="small"
          onClick={() =>
            copy(token).then(
              () => setCopied(true),
              () => onError("The browser did not let the page copy the key."),
            )
          }
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="warn">Save this key. It is the only way to get your balance back.</p>

      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          const key = other.trim();
          if (!key) return;
          setBusy(true);
          try {
            await onLoadKey(key);
            setOther("");
            setCopied(false);
          } finally {
            setBusy(false);
          }
        }}
      >
        <input value={other} onChange={(e) => setOther(e.target.value)} placeholder="Paste a different account key" aria-label="Different account key" />
        <button type="submit" className="small" disabled={busy || !other.trim()}>
          Load
        </button>
      </form>
    </section>
  );
}
