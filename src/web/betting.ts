// Draft bet logic for the table UI. The server checks every rule again with applyLayout.

import {
  layOdds,
  maxLay,
  maxOdds,
  placePays,
  trueOdds,
  unitOf,
  type Layout,
  type Limits,
  type PointNumber,
  type Table,
} from "../shared/craps";

export type Spot =
  | { kind: "pass" | "passOdds" | "dontPass" | "dontPassOdds" | "come" | "dontCome" | "field" }
  | { kind: "place" | "comeOdds" | "dontComeOdds"; n: PointNumber };

export function amountAt(layout: Layout, spot: Spot): number {
  switch (spot.kind) {
    case "place":
    case "comeOdds":
    case "dontComeOdds":
      return layout[spot.kind][spot.n] ?? 0;
    default:
      return layout[spot.kind];
  }
}

function withAmount(layout: Layout, spot: Spot, value: number): Layout {
  switch (spot.kind) {
    case "place":
    case "comeOdds":
    case "dontComeOdds":
      return { ...layout, [spot.kind]: { ...layout[spot.kind], [spot.n]: value } };
    default:
      return { ...layout, [spot.kind]: value };
  }
}

/** Returns true if the player can change this spot in the current phase. */
export function isOpen(table: Table, spot: Spot): boolean {
  switch (spot.kind) {
    case "pass":
    case "dontPass":
      return table.point === null;
    case "passOdds":
      return table.point !== null && table.pass > 0;
    case "dontPassOdds":
      return table.point !== null && table.dontPass > 0;
    case "come":
    case "dontCome":
      return table.point !== null;
    case "comeOdds":
      return table.comePoints[spot.n] !== undefined;
    case "dontComeOdds":
      return table.dontComePoints[spot.n] !== undefined;
    case "place":
    case "field":
      return true;
  }
}

/** The bet unit and the maximum for a spot. */
function rule(table: Table, spot: Spot, limits: Limits): { unit: number; max: number } {
  const flat = { unit: 1, max: limits.maxBet };
  switch (spot.kind) {
    case "place": {
      const unit = unitOf(placePays(spot.n));
      return { unit, max: limits.maxBet };
    }
    case "passOdds":
      return table.point === null ? flat : { unit: unitOf(trueOdds(table.point)), max: maxOdds(table.point, table.pass) };
    case "dontPassOdds":
      return table.point === null ? flat : { unit: unitOf(layOdds(table.point)), max: maxLay(table.dontPass) };
    case "comeOdds":
      return { unit: unitOf(trueOdds(spot.n)), max: maxOdds(spot.n, table.comePoints[spot.n]?.amount ?? 0) };
    case "dontComeOdds":
      return { unit: unitOf(layOdds(spot.n)), max: maxLay(table.dontComePoints[spot.n]?.amount ?? 0) };
    default:
      return flat;
  }
}

/**
 * Add (delta > 0) or remove (delta < 0) chips on a spot.
 * The result rounds down to the bet unit. If the round down cancels the change, the bet moves by one unit.
 */
export function adjust(table: Table, layout: Layout, spot: Spot, delta: number, limits: Limits): Layout {
  if (!isOpen(table, spot)) return layout;
  const { unit, max } = rule(table, spot, limits);
  const cap = Math.floor(max / unit) * unit;
  const current = amountAt(layout, spot);
  let next = Math.floor(Math.max(0, current + delta) / unit) * unit;
  if (delta > 0 && next <= current) next = current + unit;
  if (delta < 0 && next >= current) next = current - unit;
  next = Math.min(Math.max(0, next), cap);
  return withAmount(layout, spot, next);
}

export const sameLayout = (a: Layout, b: Layout): boolean => JSON.stringify(normal(a)) === JSON.stringify(normal(b));

function normal(l: Layout): Layout {
  const clean = (r: Partial<Record<PointNumber, number>>) =>
    Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined && v > 0).sort());
  return { ...l, comeOdds: clean(l.comeOdds), dontComeOdds: clean(l.dontComeOdds), place: clean(l.place) };
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export const sats = (n: number): string => `${n.toLocaleString("en-US")} sats`;
