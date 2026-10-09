import type { MouseEvent, ReactNode } from "react";
import { layOdds, placePays, POINTS, trueOdds, type Layout, type Limits, type PointNumber, type Table as TableState } from "../../shared/craps";
import { adjust, amountAt, compact, isOpen, type Spot } from "../betting";

interface Props {
  table: TableState;
  draft: Layout;
  limits: Limits;
  chip: number;
  locked: boolean;
  onChange: (draft: Layout) => void;
}

const ratio = ([num, den]: readonly [number, number]) => `${num}:${den}`;

export function Chip({ amount, changed, fixed }: { amount: number; changed?: boolean; fixed?: boolean }) {
  if (amount <= 0) return null;
  const tier = amount >= 10_000 ? "t5" : amount >= 1_000 ? "t4" : amount >= 100 ? "t3" : amount >= 10 ? "t2" : "t1";
  return (
    <span className={`chip ${tier}${changed ? " changed" : ""}${fixed ? " fixed" : ""}`} title={`${amount} sats`}>
      {compact(amount)}
    </span>
  );
}

export function Table({ table, draft, limits, chip, locked, onChange }: Props) {
  const handlers = (spot: Spot) => {
    const open = !locked && isOpen(table, spot);
    const change = (delta: number) => onChange(adjust(table, draft, spot, delta, limits));
    return {
      disabled: !open,
      onClick: (e: MouseEvent) => {
        e.stopPropagation();
        change(e.shiftKey ? -chip : chip);
      },
      onContextMenu: (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (open) change(-chip);
      },
    };
  };

  const serverAmount = (spot: Spot): number => {
    switch (spot.kind) {
      case "place":
        return table.place[spot.n] ?? 0;
      case "comeOdds":
        return table.comePoints[spot.n]?.odds ?? 0;
      case "dontComeOdds":
        return table.dontComePoints[spot.n]?.odds ?? 0;
      default:
        return table[spot.kind];
    }
  };

  const spot = (s: Spot, className: string, children: ReactNode, title?: string) => {
    const amount = amountAt(draft, s);
    return (
      <button type="button" className={`spot ${className}`} title={title} {...handlers(s)}>
        {children}
        <span className="stack">
          <Chip amount={amount} changed={amount !== serverAmount(s)} />
        </span>
      </button>
    );
  };

  return (
    <div className="felt" onContextMenu={(e) => e.preventDefault()}>
      <div className="puck-off-slot">{table.point === null && <span className="puck off">OFF</span>}</div>

      <div className="numbers">
        {POINTS.map((n) => (
          <PointBox key={n} n={n} table={table} draft={draft} spot={spot} handlers={handlers} />
        ))}
      </div>

      {spot(
        { kind: "dontCome" },
        "area-dc",
        <>
          <span className="label">DON&apos;T COME</span>
          <span className="hint">Bar 12</span>
        </>,
        "Don't Come: needs a point",
      )}
      {spot({ kind: "come" }, "area-come", <span className="label big">COME</span>, "Come: needs a point")}
      {spot(
        { kind: "field" },
        "area-field",
        <>
          <span className="label big">FIELD</span>
          <span className="field-numbers">
            <b className="ring">2</b> 3 4 9 10 11 <b className="ring">12</b>
          </span>
          <span className="hint">2 pays 2x. 12 pays 3x. Other field numbers pay 1:1.</span>
        </>,
      )}
      {spot(
        { kind: "dontPass" },
        "area-dp",
        <>
          <span className="label">DON&apos;T PASS BAR</span>
          <span className="hint">12 is a push</span>
        </>,
        "Don't Pass: come-out roll only",
      )}
      {spot(
        { kind: "dontPassOdds" },
        "area-dpo",
        <>
          <span className="label">DON&apos;T PASS ODDS</span>
          <span className="hint">{table.point ? `Lay ${ratio(layOdds(table.point))}, max 6x` : "Needs a point"}</span>
        </>,
      )}
      {spot({ kind: "pass" }, "area-pass", <span className="label big">PASS LINE</span>, "Pass Line: come-out roll only")}
      {spot(
        { kind: "passOdds" },
        "area-po",
        <>
          <span className="label">PASS ODDS</span>
          <span className="hint">{table.point ? `Pays ${ratio(trueOdds(table.point))}, max 3-4-5x` : "Needs a point"}</span>
        </>,
      )}
    </div>
  );
}

interface PointBoxProps {
  n: PointNumber;
  table: TableState;
  draft: Layout;
  spot: (s: Spot, className: string, children: ReactNode, title?: string) => ReactNode;
  handlers: (s: Spot) => { disabled: boolean; onClick: (e: MouseEvent) => void; onContextMenu: (e: MouseEvent) => void };
}

function PointBox({ n, table, draft, spot, handlers }: PointBoxProps) {
  const come = table.comePoints[n];
  const dontCome = table.dontComePoints[n];
  const comeOdds = draft.comeOdds[n] ?? 0;
  const layAmount = draft.dontComeOdds[n] ?? 0;
  return (
    <div className={`point-box${table.point === n ? " is-point" : ""}`}>
      {table.point === n && <span className="puck on">ON</span>}
      {spot(
        { kind: "place", n },
        "place",
        <>
          <span className="number">{n === 6 ? "SIX" : n === 9 ? "NINE" : n}</span>
          <span className="hint">Place {ratio(placePays(n))}</span>
        </>,
        `Place ${n}: off on a come-out roll`,
      )}
      {(come || dontCome) && (
        <div className="come-row">
          {come && (
            <>
              <span className="tag">C</span>
              <Chip amount={come.amount} fixed />
              <button type="button" className="odds-btn" title={`Come ${n} odds, pays ${ratio(trueOdds(n))}`} {...handlers({ kind: "comeOdds", n })}>
                {comeOdds > 0 ? <Chip amount={comeOdds} changed={comeOdds !== come.odds} /> : "+odds"}
              </button>
            </>
          )}
          {dontCome && (
            <>
              <span className="tag dc">DC</span>
              <Chip amount={dontCome.amount} fixed />
              <button type="button" className="odds-btn" title={`Don't Come ${n} lay odds, pays ${ratio(layOdds(n))}`} {...handlers({ kind: "dontComeOdds", n })}>
                {layAmount > 0 ? <Chip amount={layAmount} changed={layAmount !== dontCome.odds} /> : "+lay"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
