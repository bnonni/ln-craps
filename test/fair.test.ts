import { describe, expect, test } from "bun:test";
import { rollDice, sha256Hex, takeDice, verifyRoll } from "../src/shared/fair";
import { rollDiceSync, sha256 } from "../src/server/fair";

// Made with openssl and python, not with this code. See the procedure in src/shared/fair.ts.
const SERVER_SEED = "e48f19a1879e3b9de7241bc0d4aa81425710c2084bb493594b43f4afbfa49b7b";
const SERVER_SEED_HASH = "216fe5d493e71d99c6b1c4915bec0eb83bcd326c04d010ef66d55f4755208eb4";
const CLIENT_SEED = "player-seed";
const VECTORS: [number, [number, number]][] = [
  [0, [5, 2]],
  [1, [1, 1]],
  [2, [6, 4]],
  [3, [5, 6]],
  [4, [2, 2]],
];

describe("provably fair dice", () => {
  test("the server and the browser match the openssl vectors", async () => {
    expect(sha256(SERVER_SEED)).toBe(SERVER_SEED_HASH);
    expect(await sha256Hex(SERVER_SEED)).toBe(SERVER_SEED_HASH);
    for (const [nonce, dice] of VECTORS) {
      expect(rollDiceSync(SERVER_SEED, CLIENT_SEED, nonce)).toEqual(dice);
      expect(await rollDice(SERVER_SEED, CLIENT_SEED, nonce)).toEqual(dice);
    }
  });

  test("the server and the browser give the same dice for 2000 nonces", async () => {
    for (let nonce = 0; nonce < 2000; nonce++) {
      expect(await rollDice(SERVER_SEED, "abc", nonce)).toEqual(rollDiceSync(SERVER_SEED, "abc", nonce));
    }
  });

  test("bytes from 252 to 255 are rejected", () => {
    const dice: number[] = [];
    takeDice(new Uint8Array([252, 253, 254, 255, 0, 251, 9]), dice);
    expect(dice).toEqual([1, 6]);
  });

  test("each face has a probability near 1/6", () => {
    const counts = [0, 0, 0, 0, 0, 0];
    const n = 60_000;
    for (let nonce = 0; nonce < n / 2; nonce++) {
      const [a, b] = rollDiceSync(SERVER_SEED, "distribution", nonce);
      counts[a - 1]!++;
      counts[b - 1]!++;
    }
    const expected = n / 6;
    const chi2 = counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
    // 5 degrees of freedom: chi-square > 20.5 has a probability of 0.001.
    expect(chi2).toBeLessThan(20.5);
  });

  test("verifyRoll rejects a wrong seed, a wrong hash, and wrong dice", async () => {
    const good = { serverSeed: SERVER_SEED, serverSeedHash: SERVER_SEED_HASH, clientSeed: CLIENT_SEED, nonce: 0, dice: [5, 2] as const };
    expect(await verifyRoll(good)).toBe(true);
    expect(await verifyRoll({ ...good, dice: [2, 5] })).toBe(false);
    expect(await verifyRoll({ ...good, serverSeedHash: "00" })).toBe(false);
    expect(await verifyRoll({ ...good, clientSeed: "other" })).toBe(false);
  });
});
