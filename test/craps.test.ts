import { describe, expect, test } from "bun:test";
import {
  applyLayout,
  emptyLayout,
  emptyTable,
  layoutOf,
  POINTS,
  resolveRoll,
  RuleError,
  stakeOf,
  type Dice,
  type Layout,
  type PointNumber,
  type RollResolution,
  type Table,
} from "../src/shared/craps";

const LIMITS = { minBet: 1, maxBet: 1_000_000 };
const ALL_DICE: Dice[] = [];
for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) ALL_DICE.push([a, b]);

const table = (patch: Partial<Table>): Table => ({ ...emptyTable(), ...patch });
const net = (r: RollResolution) => r.results.reduce((s, x) => s + (x.outcome === "lose" ? -x.stake : x.win), 0);
const diceFor = (sum: number): Dice => (sum <= 7 ? [1, sum - 1] : [6, sum - 6]);

/** The expected net of one roll, over all 36 dice outcomes. */
const evOneRoll = (t: Table) => ALL_DICE.reduce((s, d) => s + net(resolveRoll(t, d)), 0) / 36;

/** The probability that the point wins before a seven, measured with the engine. */
function pointWinProbability(t: Table): number {
  let made = 0;
  let out = 0;
  for (const d of ALL_DICE) {
    const { event } = resolveRoll(t, d);
    if (event === "point-made") made++;
    if (event === "seven-out") out++;
  }
  return made / (made + out);
}

/** Expected net of a bet that is resolved over many rolls. `onPoint` gives the net for a win and a loss. */
function evPerDecision(t: Table, bet: string): number {
  let total = 0;
  let decisions = 0;
  for (const d of ALL_DICE) {
    const r = resolveRoll(t, d).results.find((x) => x.bet === bet && x.outcome !== "push");
    if (!r) continue;
    decisions++;
    total += r.outcome === "lose" ? -r.stake : r.win;
  }
  return total / decisions;
}

describe("house edge (exact, from the engine)", () => {
  test("Pass Line: -7/495", () => {
    let ev = 0;
    for (const d of ALL_DICE) {
      const r = resolveRoll(table({ pass: 1 }), d);
      if (r.event === "point-set") {
        const p = pointWinProbability(r.table);
        ev += (p - (1 - p)) / 36;
      } else ev += net(r) / 36;
    }
    expect(ev).toBeCloseTo(-7 / 495, 12);
  });

  test("Don't Pass: -3/220", () => {
    let ev = 0;
    for (const d of ALL_DICE) {
      const r = resolveRoll(table({ dontPass: 1 }), d);
      if (r.event === "point-set") {
        const p = pointWinProbability(r.table);
        ev += ((1 - p) - p) / 36;
      } else ev += net(r) / 36;
    }
    expect(ev).toBeCloseTo(-3 / 220, 12);
  });

  test("Field (2 pays 2x, 12 pays 3x): -1/36", () => {
    expect(evOneRoll(table({ field: 1 }))).toBeCloseTo(-1 / 36, 12);
  });

  test("Place bets per decision: 4/10 -1/15, 5/9 -1/25, 6/8 -1/66", () => {
    const edge: Record<PointNumber, number> = { 4: -1 / 15, 5: -1 / 25, 6: -1 / 66, 8: -1 / 66, 9: -1 / 25, 10: -1 / 15 };
    for (const n of POINTS) {
      const stake = 30; // a multiple of 5 and 6
      const t = table({ point: n === 4 ? 5 : 4, place: { [n]: stake } });
      expect(evPerDecision(t, `Place ${n}`) / stake).toBeCloseTo(edge[n], 12);
    }
  });

  test("Pass Odds and Don't Pass Odds have no house edge", () => {
    for (const n of POINTS) {
      expect(evPerDecision(table({ point: n, pass: 10, passOdds: 30 }), "Pass Odds")).toBeCloseTo(0, 12);
      expect(evPerDecision(table({ point: n, dontPass: 10, dontPassOdds: 60 }), "Don't Pass Odds")).toBeCloseTo(0, 12);
    }
  });
});

describe("resolveRoll", () => {
  test("come-out natural: Pass wins and stays, Don't Pass loses", () => {
    const r = resolveRoll(table({ pass: 10, dontPass: 10 }), [3, 4]);
    expect(r.event).toBe("natural");
    expect(r.table.pass).toBe(10);
    expect(r.table.dontPass).toBe(0);
    expect(r.credit).toBe(10);
  });

  test("come-out 12: Pass loses, Don't Pass is a push", () => {
    const r = resolveRoll(table({ pass: 10, dontPass: 10 }), [6, 6]);
    expect(r.table.pass).toBe(0);
    expect(r.table.dontPass).toBe(10);
    expect(r.credit).toBe(0);
  });

  test("point made: Pass and odds win, odds come off the table", () => {
    const r = resolveRoll(table({ point: 6, pass: 10, passOdds: 50 }), [2, 4]);
    expect(r.event).toBe("point-made");
    expect(r.table.point).toBeNull();
    expect(r.table.pass).toBe(10);
    expect(r.table.passOdds).toBe(0);
    expect(r.credit).toBe(10 + 50 + 60);
  });

  test("seven out: Don't Pass and lay odds win, Place bets lose", () => {
    const r = resolveRoll(table({ point: 4, dontPass: 10, dontPassOdds: 60, place: { 6: 12 } }), [3, 4]);
    expect(r.event).toBe("seven-out");
    expect(r.credit).toBe(10 + 60 + 30);
    expect(r.table.place).toEqual({});
  });

  test("Place bets are off on the come-out roll", () => {
    const r = resolveRoll(table({ place: { 6: 12 } }), [3, 4]);
    expect(r.results).toEqual([]);
    expect(r.table.place).toEqual({ 6: 12 });
  });

  test("a Come bet moves to its number, then wins with odds", () => {
    const moved = resolveRoll(table({ point: 4, pass: 5, come: 10 }), [3, 5]);
    expect(moved.table.comePoints).toEqual({ 8: { amount: 10, odds: 0 } });
    const withOdds = { ...moved.table, comePoints: { 8: { amount: 10, odds: 50 } } };
    const won = resolveRoll(withOdds, [4, 4]);
    expect(won.table.comePoints).toEqual({});
    expect(won.credit).toBe(10 + 10 + 50 + 60);
  });

  test("Come odds are off on a come-out roll", () => {
    const r = resolveRoll(table({ comePoints: { 5: { amount: 10, odds: 40 } } }), [3, 4]);
    expect(r.results.map((x) => [x.bet, x.outcome])).toEqual([
      ["Come 5", "lose"],
      ["Come 5 Odds", "push"],
    ]);
    expect(r.credit).toBe(40);
  });

  test("a Don't Come bet on 12 is a push and stays", () => {
    const r = resolveRoll(table({ point: 5, dontCome: 10 }), [6, 6]);
    expect(r.table.dontCome).toBe(10);
    expect(r.credit).toBe(0);
  });

  test("bookkeeping: stakes that leave the table = lost stakes + returned stakes", () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    let t = emptyTable();
    for (let i = 0; i < 20_000; i++) {
      const layout = randomLayout(t, rand);
      t = applyLayout(t, layout, LIMITS).table;
      const before = stakeOf(t);
      const r = resolveRoll(t, [1 + Math.floor(rand() * 6), 1 + Math.floor(rand() * 6)]);
      const lost = r.results.filter((x) => x.outcome === "lose").reduce((s, x) => s + x.stake, 0);
      const wins = r.results.reduce((s, x) => s + x.win, 0);
      expect(before - stakeOf(r.table)).toBe(lost + (r.credit - wins));
      t = r.table;
    }
  });
});

/** A random legal layout, to stress the engine. */
function randomLayout(t: Table, rand: () => number): Layout {
  const l = layoutOf(t);
  const pick = (max: number, unit = 1) => Math.floor((rand() * max) / unit) * unit;
  if (t.point === null) {
    l.pass = pick(100);
    l.dontPass = pick(100);
    l.passOdds = 0;
    l.dontPassOdds = 0;
  } else {
    const units = { 4: [1, 2], 5: [2, 3], 6: [5, 6], 8: [5, 6], 9: [2, 3], 10: [1, 2] }[t.point]!;
    if (l.pass > 0) l.passOdds = pick(l.pass * 3, units[0]);
    if (l.dontPass > 0) l.dontPassOdds = pick(l.dontPass * 6, units[1]);
    l.come = pick(50);
    l.dontCome = pick(50);
  }
  for (const n of POINTS) {
    l.place[n] = pick(60, n === 6 || n === 8 ? 6 : 5);
    if (t.comePoints[n]) l.comeOdds[n] = pick(t.comePoints[n].amount * 3, n === 6 || n === 8 ? 5 : 2);
    if (t.dontComePoints[n]) l.dontComeOdds[n] = pick(t.dontComePoints[n].amount * 6, 6);
  }
  l.field = pick(50);
  return l;
}

describe("applyLayout", () => {
  const point = table({ point: 6, pass: 10 });

  test("the cost is the change in stakes", () => {
    const { cost } = applyLayout(emptyTable(), { ...emptyLayout(), pass: 10, field: 5 }, LIMITS);
    expect(cost).toBe(15);
    const back = applyLayout(table({ pass: 10, field: 5 }), emptyLayout(), LIMITS);
    expect(back.cost).toBe(-15);
  });

  const rejects = (t: Table, patch: Partial<Layout>, message: RegExp) =>
    expect(() => applyLayout(t, { ...layoutOf(t), ...patch }, LIMITS)).toThrow(message);

  test("rules", () => {
    rejects(point, { pass: 20 }, /cannot change/);
    rejects(point, { pass: 0 }, /cannot change/);
    rejects(table({ point: 6, dontPass: 10 }), { dontPass: 0 }, /cannot change/);
    rejects(emptyTable(), { passOdds: 10 }, /need a Pass Line bet and a point/);
    rejects(point, { passOdds: 55 }, /maximum is 50/);
    rejects(point, { passOdds: 12 }, /multiple of 5/);
    rejects(emptyTable(), { come: 10 }, /need a point/);
    rejects(emptyTable(), { place: { 6: 10 } }, /multiple of 6/);
    rejects(emptyTable(), { place: { 7: 10 } as never }, /not a point number/);
    rejects(emptyTable(), { field: -1 }, /0 or more/);
    rejects(emptyTable(), { field: 1.5 }, /whole number/);
    rejects(emptyTable(), { field: 2_000_000 }, /from 1 to 1000000/);
    rejects(point, { comeOdds: { 8: 10 } }, /no Come bet on 8/);
  });

  test("a legal layout passes", () => {
    const t = table({ point: 6, pass: 10, comePoints: { 5: { amount: 10, odds: 0 } } });
    const layout = { ...layoutOf(t), passOdds: 50, comeOdds: { 5: 40 }, place: { 8: 12 }, come: 5 };
    expect(() => applyLayout(t, layout, LIMITS)).not.toThrow();
    expect(new RuleError("x")).toBeInstanceOf(Error);
  });
});
