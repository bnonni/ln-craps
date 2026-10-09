import type { RollRecord } from "../../shared/api";
import type { Dice as DiceValues, RollEvent } from "../../shared/craps";
import { sats } from "../betting";

const PIPS: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

function Die({ value, rolling }: { value: number; rolling: boolean }) {
  const pips = PIPS[value] ?? [];
  return (
    <div className={`die${rolling ? " rolling" : ""}`} aria-label={`Die shows ${value}`}>
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className={pips.includes(i) ? "pip" : ""} />
      ))}
    </div>
  );
}

export function eventText(event: RollEvent, sum: number): string {
  switch (event) {
    case "natural":
      return "Natural";
    case "craps":
      return "Craps";
    case "point-set":
      return `Point is ${sum}`;
    case "point-made":
      return "Point made";
    case "seven-out":
      return "Seven out";
    default:
      return "";
  }
}

interface Props {
  shown: DiceValues | null;
  rolling: boolean;
  last: RollRecord | null;
}

export function DicePanel({ shown, rolling, last }: Props) {
  const dice = shown ?? [1, 1];
  const sum = dice[0] + dice[1];
  return (
    <section className="panel dice-panel">
      <div className="dice">
        <Die value={dice[0]} rolling={rolling} />
        <Die value={dice[1]} rolling={rolling} />
      </div>
      {!rolling && last && (
        <>
          <div className="roll-total">
            <span className="sum">{sum}</span>
            <span className="event">{eventText(last.event, sum)}</span>
          </div>
          {last.results.length > 0 ? (
            <ul className="results">
              {last.results.map((r, i) => (
                <li key={i} className={r.outcome}>
                  <span>{r.bet}</span>
                  <span>
                    {r.outcome === "win" && `+${sats(r.win)}`}
                    {r.outcome === "lose" && `-${sats(r.stake)}`}
                    {r.outcome === "push" && "push"}
                    {r.outcome === "move" && "moves"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No bet result on this roll.</p>
          )}
          <div className={`net ${last.net > 0 ? "win" : last.net < 0 ? "lose" : "push"}`}>
            Net: {last.net > 0 ? "+" : ""}
            {sats(last.net)}
          </div>
        </>
      )}
      {!rolling && !last && <p className="muted">Put chips on the table. Then push Roll.</p>}
    </section>
  );
}
