// Craps rules engine. Pure functions, shared by the server and the browser.
//
// Money model: a bet stake leaves the balance when the bet goes on the table.
// When a roll resolves a bet, `credit` is the amount that goes back to the balance.
// A winning bet that stays on the table (Pass Line, Place, Field) credits only the win.

export const POINTS = [4, 5, 6, 8, 9, 10] as const;
export type PointNumber = (typeof POINTS)[number];
export type Dice = readonly [number, number];

/** A payout ratio: the bet wins `amount * num / den`. */
export type Ratio = readonly [num: number, den: number];

export interface FlatWithOdds {
  amount: number;
  odds: number;
}

export type ByPoint<T> = Partial<Record<PointNumber, T>>;

export interface Table {
  point: PointNumber | null;
  pass: number;
  passOdds: number;
  dontPass: number;
  dontPassOdds: number;
  /** A new Come bet. The next roll resolves it or moves it to a number. */
  come: number;
  /** A new Don't Come bet. The next roll resolves it or moves it to a number. */
  dontCome: number;
  comePoints: ByPoint<FlatWithOdds>;
  dontComePoints: ByPoint<FlatWithOdds>;
  place: ByPoint<number>;
  field: number;
}

/** The bets that a player can set before a roll. */
export interface Layout {
  pass: number;
  passOdds: number;
  dontPass: number;
  dontPassOdds: number;
  come: number;
  dontCome: number;
  comeOdds: ByPoint<number>;
  dontComeOdds: ByPoint<number>;
  place: ByPoint<number>;
  field: number;
}

export interface Limits {
  minBet: number;
  maxBet: number;
}

export type Outcome = "win" | "lose" | "push" | "move";

export interface BetResult {
  bet: string;
  outcome: Outcome;
  stake: number;
  /** The win amount. Zero if the bet did not win. */
  win: number;
  /** The amount that goes back to the balance. */
  credit: number;
}

export type RollEvent = "natural" | "craps" | "point-set" | "point-made" | "seven-out" | null;

export interface RollResolution {
  table: Table;
  results: BetResult[];
  credit: number;
  event: RollEvent;
}

export class RuleError extends Error {}

export const isPoint = (n: number): n is PointNumber => (POINTS as readonly number[]).includes(n);

// Payout ratios.
const TRUE_ODDS: Record<PointNumber, Ratio> = { 4: [2, 1], 5: [3, 2], 6: [6, 5], 8: [6, 5], 9: [3, 2], 10: [2, 1] };
const LAY_ODDS: Record<PointNumber, Ratio> = { 4: [1, 2], 5: [2, 3], 6: [5, 6], 8: [5, 6], 9: [2, 3], 10: [1, 2] };
const PLACE_PAYS: Record<PointNumber, Ratio> = { 4: [9, 5], 5: [7, 5], 6: [7, 6], 8: [7, 6], 9: [7, 5], 10: [9, 5] };
const EVEN: Ratio = [1, 1];

/** 3-4-5x odds: the maximum Pass and Come odds, as a multiple of the flat bet. */
const ODDS_MULTIPLE: Record<PointNumber, number> = { 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3 };
/** The maximum Don't Pass and Don't Come odds, as a multiple of the flat bet. */
const LAY_MULTIPLE = 6;

export const trueOdds = (n: PointNumber): Ratio => TRUE_ODDS[n];
export const layOdds = (n: PointNumber): Ratio => LAY_ODDS[n];
export const placePays = (n: PointNumber): Ratio => PLACE_PAYS[n];

/** A bet with this ratio must be a multiple of the unit, so that the win is a whole number of sats. */
export const unitOf = (ratio: Ratio): number => ratio[1];
export const maxOdds = (n: PointNumber, flat: number): number => flat * ODDS_MULTIPLE[n];
export const maxLay = (flat: number): number => flat * LAY_MULTIPLE;

/** Validation makes sure that each stake is a multiple of the ratio unit, so the division is exact. */
const winOf = (stake: number, [num, den]: Ratio): number => (stake * num) / den;

export function emptyTable(): Table {
  return {
    point: null,
    pass: 0,
    passOdds: 0,
    dontPass: 0,
    dontPassOdds: 0,
    come: 0,
    dontCome: 0,
    comePoints: {},
    dontComePoints: {},
    place: {},
    field: 0,
  };
}

export function emptyLayout(): Layout {
  return layoutOf(emptyTable());
}

export function layoutOf(table: Table): Layout {
  const comeOdds: ByPoint<number> = {};
  const dontComeOdds: ByPoint<number> = {};
  for (const n of POINTS) {
    const c = table.comePoints[n];
    if (c) comeOdds[n] = c.odds;
    const d = table.dontComePoints[n];
    if (d) dontComeOdds[n] = d.odds;
  }
  return {
    pass: table.pass,
    passOdds: table.passOdds,
    dontPass: table.dontPass,
    dontPassOdds: table.dontPassOdds,
    come: table.come,
    dontCome: table.dontCome,
    comeOdds,
    dontComeOdds,
    place: { ...table.place },
    field: table.field,
  };
}

/** The total of all stakes on the table. */
export function stakeOf(table: Table): number {
  let total = table.pass + table.passOdds + table.dontPass + table.dontPassOdds + table.come + table.dontCome + table.field;
  for (const n of POINTS) {
    total += table.place[n] ?? 0;
    total += (table.comePoints[n]?.amount ?? 0) + (table.comePoints[n]?.odds ?? 0);
    total += (table.dontComePoints[n]?.amount ?? 0) + (table.dontComePoints[n]?.odds ?? 0);
  }
  return total;
}

function amount(value: unknown, name: string): number {
  const v = value ?? 0;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new RuleError(`${name}: the amount must be a whole number of sats, 0 or more.`);
  }
  return v;
}

function flat(value: unknown, name: string, limits: Limits): number {
  const v = amount(value, name);
  if (v !== 0 && (v < limits.minBet || v > limits.maxBet)) {
    throw new RuleError(`${name}: the bet must be from ${limits.minBet} to ${limits.maxBet} sats.`);
  }
  return v;
}

function multipleOf(v: number, unit: number, name: string): number {
  if (v % unit !== 0) throw new RuleError(`${name}: the bet must be a multiple of ${unit} sats.`);
  return v;
}

function byPoint(value: unknown, name: string): ByPoint<unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new RuleError(`${name}: expected an object.`);
  for (const key of Object.keys(value)) {
    if (!isPoint(Number(key))) throw new RuleError(`${name}: ${key} is not a point number.`);
  }
  return value as ByPoint<unknown>;
}

/**
 * Apply the bets that the player wants to the current table.
 * Returns the new table and the cost (a positive cost comes out of the balance, a negative cost goes back).
 * Throws a RuleError if the layout breaks a table rule.
 */
export function applyLayout(current: Table, layout: Layout, limits: Limits): { table: Table; cost: number } {
  const next: Table = {
    ...emptyTable(),
    point: current.point,
    comePoints: {},
    dontComePoints: {},
  };
  const point = current.point;

  // Pass Line and Don't Pass are contract bets: they are fixed after the point is set.
  next.pass = flat(layout.pass, "Pass Line", limits);
  next.dontPass = flat(layout.dontPass, "Don't Pass", limits);
  if (point !== null) {
    if (next.pass !== current.pass) throw new RuleError("Pass Line: you cannot change this bet after the point is set.");
    if (next.dontPass !== current.dontPass) {
      throw new RuleError("Don't Pass: you cannot change this bet after the point is set.");
    }
  }

  next.passOdds = amount(layout.passOdds, "Pass Odds");
  if (next.passOdds > 0) {
    if (point === null || next.pass === 0) throw new RuleError("Pass Odds: you need a Pass Line bet and a point.");
    if (next.passOdds > maxOdds(point, next.pass)) {
      throw new RuleError(`Pass Odds: the maximum is ${maxOdds(point, next.pass)} sats.`);
    }
    multipleOf(next.passOdds, unitOf(trueOdds(point)), "Pass Odds");
  }

  next.dontPassOdds = amount(layout.dontPassOdds, "Don't Pass Odds");
  if (next.dontPassOdds > 0) {
    if (point === null || next.dontPass === 0) {
      throw new RuleError("Don't Pass Odds: you need a Don't Pass bet and a point.");
    }
    if (next.dontPassOdds > maxLay(next.dontPass)) {
      throw new RuleError(`Don't Pass Odds: the maximum is ${maxLay(next.dontPass)} sats.`);
    }
    multipleOf(next.dontPassOdds, unitOf(layOdds(point)), "Don't Pass Odds");
  }

  next.come = flat(layout.come, "Come", limits);
  next.dontCome = flat(layout.dontCome, "Don't Come", limits);
  if (point === null && next.come > 0) throw new RuleError("Come: you need a point. Use the Pass Line on a come-out roll.");
  if (point === null && next.dontCome > 0) {
    throw new RuleError("Don't Come: you need a point. Use Don't Pass on a come-out roll.");
  }

  // Come and Don't Come numbers: the flat bets are fixed. The player can change the odds.
  const comeOdds = byPoint(layout.comeOdds, "Come Odds");
  const dontComeOdds = byPoint(layout.dontComeOdds, "Don't Come Odds");
  for (const n of POINTS) {
    const c = current.comePoints[n];
    const odds = amount(comeOdds[n], `Come ${n} Odds`);
    if (c) {
      if (odds > maxOdds(n, c.amount)) throw new RuleError(`Come ${n} Odds: the maximum is ${maxOdds(n, c.amount)} sats.`);
      next.comePoints[n] = { amount: c.amount, odds: multipleOf(odds, unitOf(trueOdds(n)), `Come ${n} Odds`) };
    } else if (odds > 0) {
      throw new RuleError(`Come ${n} Odds: you have no Come bet on ${n}.`);
    }

    const d = current.dontComePoints[n];
    const lay = amount(dontComeOdds[n], `Don't Come ${n} Odds`);
    if (d) {
      if (lay > maxLay(d.amount)) throw new RuleError(`Don't Come ${n} Odds: the maximum is ${maxLay(d.amount)} sats.`);
      next.dontComePoints[n] = { amount: d.amount, odds: multipleOf(lay, unitOf(layOdds(n)), `Don't Come ${n} Odds`) };
    } else if (lay > 0) {
      throw new RuleError(`Don't Come ${n} Odds: you have no Don't Come bet on ${n}.`);
    }
  }

  const place = byPoint(layout.place, "Place");
  for (const n of POINTS) {
    const v = flat(place[n], `Place ${n}`, limits);
    if (v > 0) next.place[n] = multipleOf(v, unitOf(placePays(n)), `Place ${n}`);
  }

  next.field = flat(layout.field, "Field", limits);

  return { table: next, cost: stakeOf(next) - stakeOf(current) };
}

/** Resolve one roll of the dice against the table. */
export function resolveRoll(current: Table, dice: Dice): RollResolution {
  const t: Table = structuredClone(current);
  const sum = dice[0] + dice[1];
  const comeOut = t.point === null;
  const results: BetResult[] = [];

  const win = (bet: string, stake: number, ratio: Ratio, stays: boolean) => {
    const w = winOf(stake, ratio);
    results.push({ bet, outcome: "win", stake, win: w, credit: stays ? w : stake + w });
  };
  const lose = (bet: string, stake: number) => results.push({ bet, outcome: "lose", stake, win: 0, credit: 0 });
  const push = (bet: string, stake: number, returned: boolean) =>
    results.push({ bet, outcome: "push", stake, win: 0, credit: returned ? stake : 0 });
  const move = (bet: string, stake: number) => results.push({ bet, outcome: "move", stake, win: 0, credit: 0 });

  // Field: a one-roll bet. 2 pays 2 to 1, 12 pays 3 to 1. A winning bet stays.
  if (t.field > 0) {
    if (sum === 2) win("Field", t.field, [2, 1], true);
    else if (sum === 12) win("Field", t.field, [3, 1], true);
    else if ([3, 4, 9, 10, 11].includes(sum)) win("Field", t.field, EVEN, true);
    else {
      lose("Field", t.field);
      t.field = 0;
    }
  }

  // Place bets are off on a come-out roll. A winning bet stays.
  if (!comeOut) {
    for (const n of POINTS) {
      const stake = t.place[n];
      if (!stake) continue;
      if (sum === n) win(`Place ${n}`, stake, placePays(n), true);
      else if (sum === 7) {
        lose(`Place ${n}`, stake);
        delete t.place[n];
      }
    }
  }

  // Come numbers. The odds are off on a come-out roll, so they go back to the player.
  for (const n of POINTS) {
    const c = t.comePoints[n];
    if (!c || (sum !== n && sum !== 7)) continue;
    if (sum === n) win(`Come ${n}`, c.amount, EVEN, false);
    else lose(`Come ${n}`, c.amount);
    if (c.odds > 0) {
      if (comeOut) push(`Come ${n} Odds`, c.odds, true);
      else if (sum === n) win(`Come ${n} Odds`, c.odds, trueOdds(n), false);
      else lose(`Come ${n} Odds`, c.odds);
    }
    delete t.comePoints[n];
  }

  // Don't Come numbers. The odds always work.
  for (const n of POINTS) {
    const d = t.dontComePoints[n];
    if (!d || (sum !== n && sum !== 7)) continue;
    if (sum === 7) {
      win(`Don't Come ${n}`, d.amount, EVEN, false);
      if (d.odds > 0) win(`Don't Come ${n} Odds`, d.odds, layOdds(n), false);
    } else {
      lose(`Don't Come ${n}`, d.amount);
      if (d.odds > 0) lose(`Don't Come ${n} Odds`, d.odds);
    }
    delete t.dontComePoints[n];
  }

  // A new Come bet acts like a Pass Line bet on its own come-out roll.
  if (t.come > 0) {
    if (sum === 7 || sum === 11) win("Come", t.come, EVEN, false);
    else if (sum === 2 || sum === 3 || sum === 12) lose("Come", t.come);
    else if (isPoint(sum)) {
      move(`Come to ${sum}`, t.come);
      const prev = t.comePoints[sum];
      t.comePoints[sum] = { amount: (prev?.amount ?? 0) + t.come, odds: prev?.odds ?? 0 };
    }
    t.come = 0;
  }

  // A new Don't Come bet. A 12 is a push and the bet stays for the next roll.
  if (t.dontCome > 0) {
    if (sum === 12) push("Don't Come", t.dontCome, false);
    else {
      if (sum === 2 || sum === 3) win("Don't Come", t.dontCome, EVEN, false);
      else if (sum === 7 || sum === 11) lose("Don't Come", t.dontCome);
      else if (isPoint(sum)) {
        move(`Don't Come to ${sum}`, t.dontCome);
        const prev = t.dontComePoints[sum];
        t.dontComePoints[sum] = { amount: (prev?.amount ?? 0) + t.dontCome, odds: prev?.odds ?? 0 };
      }
      t.dontCome = 0;
    }
  }

  // Pass Line and Don't Pass. A winning flat bet stays on the line. Odds go back with the win.
  let event: RollEvent = null;
  if (comeOut) {
    if (sum === 7 || sum === 11) {
      event = "natural";
      if (t.pass > 0) win("Pass Line", t.pass, EVEN, true);
      if (t.dontPass > 0) {
        lose("Don't Pass", t.dontPass);
        t.dontPass = 0;
      }
    } else if (sum === 2 || sum === 3 || sum === 12) {
      event = "craps";
      if (t.pass > 0) {
        lose("Pass Line", t.pass);
        t.pass = 0;
      }
      if (t.dontPass > 0) {
        if (sum === 12) push("Don't Pass", t.dontPass, false);
        else win("Don't Pass", t.dontPass, EVEN, true);
      }
    } else if (isPoint(sum)) {
      event = "point-set";
      t.point = sum;
    }
  } else if (t.point !== null && (sum === t.point || sum === 7)) {
    const point = t.point;
    const made = sum === point;
    event = made ? "point-made" : "seven-out";
    if (t.pass > 0) {
      if (made) win("Pass Line", t.pass, EVEN, true);
      else {
        lose("Pass Line", t.pass);
        t.pass = 0;
      }
    }
    if (t.passOdds > 0) {
      if (made) win("Pass Odds", t.passOdds, trueOdds(point), false);
      else lose("Pass Odds", t.passOdds);
      t.passOdds = 0;
    }
    if (t.dontPass > 0) {
      if (made) {
        lose("Don't Pass", t.dontPass);
        t.dontPass = 0;
      } else win("Don't Pass", t.dontPass, EVEN, true);
    }
    if (t.dontPassOdds > 0) {
      if (made) lose("Don't Pass Odds", t.dontPassOdds);
      else win("Don't Pass Odds", t.dontPassOdds, layOdds(point), false);
      t.dontPassOdds = 0;
    }
    t.point = null;
  }

  const credit = results.reduce((s, r) => s + r.credit, 0);
  return { table: t, results, credit, event };
}
