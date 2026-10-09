import { useState } from "react";
import type { Fairness, RevealedSeed, RollRecord } from "../../shared/api";
import { verifyRoll } from "../../shared/fair";
import { api, errorText } from "../api";
import { sats, compact } from "../betting";
import { eventText } from "./Dice";

const FACES = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

export const randomSeed = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

interface Props {
  fairness: Fairness;
  previousSeed: RevealedSeed | null;
  rolls: RollRecord[];
  onRotated: (fairness: Fairness, previousSeed: RevealedSeed) => void;
  onError: (message: string) => void;
}

export function FairPanel({ fairness, previousSeed, rolls, onRotated, onError }: Props) {
  const [clientSeed, setClientSeed] = useState(randomSeed);
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<Record<string, boolean | "busy">>({});

  async function rotate() {
    const seed = clientSeed.trim();
    if (!seed) {
      onError("The client seed must not be empty.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.rotateSeed(seed);
      onRotated(res.fairness, res.previousSeed);
      setClientSeed(randomSeed());
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify(roll: RollRecord) {
    if (!roll.serverSeed) return;
    const key = `${roll.serverSeedHash}:${roll.nonce}`;
    setChecks((c) => ({ ...c, [key]: "busy" }));
    const ok = await verifyRoll({
      serverSeed: roll.serverSeed,
      serverSeedHash: roll.serverSeedHash,
      clientSeed: roll.clientSeed,
      nonce: roll.nonce,
      dice: roll.dice,
    }).catch(() => false);
    setChecks((c) => ({ ...c, [key]: ok }));
  }

  return (
    <section className="panel fair">
      <h2>Provably fair</h2>

      <dl className="seeds">
        <dt>Server seed hash (SHA-256)</dt>
        <dd className="hash">{fairness.serverSeedHash}</dd>
        <dt>Client seed</dt>
        <dd className="hash">{fairness.clientSeed}</dd>
        <dt>Next nonce</dt>
        <dd>{fairness.nonce}</dd>
      </dl>

      <form
        className="rotate"
        onSubmit={(e) => {
          e.preventDefault();
          void rotate();
        }}
      >
        <label>
          New client seed
          <input value={clientSeed} onChange={(e) => setClientSeed(e.target.value)} spellCheck={false} />
        </label>
        <button type="submit" disabled={busy}>
          Rotate seeds
        </button>
        <p className="muted">Rotation shows the current server seed and starts a new seed pair at nonce 0.</p>
      </form>

      {previousSeed && (
        <dl className="seeds revealed">
          <dt>Previous server seed (revealed)</dt>
          <dd className="hash">{previousSeed.serverSeed}</dd>
          <dt>Previous server seed hash</dt>
          <dd className="hash">{previousSeed.serverSeedHash}</dd>
          <dt>Previous client seed</dt>
          <dd className="hash">{previousSeed.clientSeed}</dd>
          <dt>Rolls with this pair</dt>
          <dd>{previousSeed.rolls}</dd>
        </dl>
      )}

      <details className="method">
        <summary>How to verify a roll</summary>
        <ol>
          <li>Before you bet, the server shows the SHA-256 hash of its secret server seed. After this, the server cannot change the seed.</li>
          <li>You set the client seed. Thus the server cannot select a seed that gives bad rolls for you.</li>
          <li>
            For each roll, the server calculates HMAC-SHA512 with the server seed as the key and{" "}
            <code>clientSeed:nonce:round</code> as the message. The round starts at 0. The nonce increases by 1 for each roll.
          </li>
          <li>
            The server reads the bytes in order. It rejects each byte of 252 or more. Each other byte gives a die: byte mod 6, plus 1.
            This gives each face a probability of exactly 1/6. If round 0 does not give two dice, the server uses round 1, and so on.
          </li>
          <li>When you rotate the seeds, the server shows the old server seed. Then you can calculate each old roll again.</li>
        </ol>
        <p className="muted">
          To check a roll with OpenSSL: <code>echo -n "CLIENT_SEED:NONCE:0" | openssl dgst -sha512 -hmac "SERVER_SEED"</code>
        </p>
      </details>

      <h3>Roll history</h3>
      {rolls.length === 0 ? (
        <p className="muted">No rolls yet.</p>
      ) : (
        <table className="history">
          <thead>
            <tr>
              <th>Nonce</th>
              <th>Dice</th>
              <th>Event</th>
              <th>Net</th>
              <th>Check</th>
            </tr>
          </thead>
          <tbody>
            {rolls.map((r) => {
              const key = `${r.serverSeedHash}:${r.nonce}`;
              const check = checks[key];
              return (
                <tr key={key}>
                  <td>{r.nonce}</td>
                  <td className="faces" title={`${r.dice[0]} + ${r.dice[1]}`}>
                    {FACES[r.dice[0]]}
                    {FACES[r.dice[1]]}
                  </td>
                  <td>{eventText(r.event, r.dice[0] + r.dice[1]) || r.dice[0] + r.dice[1]}</td>
                  <td className={r.net > 0 ? "win" : r.net < 0 ? "lose" : ""} title={sats(r.net)}>
                    {r.net > 0 ? "+" : r.net < 0 ? "-" : ""}
                    {compact(Math.abs(r.net))}
                  </td>
                  <td>
                    {r.serverSeed === null ? (
                      <span className="muted" title="Rotate the seeds to reveal the server seed.">
                        hidden
                      </span>
                    ) : check === true ? (
                      <span className="ok">✓</span>
                    ) : check === false ? (
                      <span className="bad">✗</span>
                    ) : (
                      <button type="button" className="small" disabled={check === "busy"} onClick={() => void verify(r)}>
                        Verify
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
