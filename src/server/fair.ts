// Server side of the provably fair dice. Synchronous, so that a roll fits in one SQLite transaction.
// The algorithm must stay identical to rollDice() in src/shared/fair.ts. A test compares the two.

import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Dice } from "../shared/craps";
import { rollMessage, takeDice } from "../shared/fair";

export const newServerSeed = (): string => randomBytes(32).toString("hex");
export const newClientSeed = (): string => randomBytes(16).toString("hex");
export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export function rollDiceSync(serverSeed: string, clientSeed: string, nonce: number): Dice {
  const dice: number[] = [];
  for (let round = 0; dice.length < 2; round++) {
    takeDice(createHmac("sha512", serverSeed).update(rollMessage(clientSeed, nonce, round)).digest(), dice);
  }
  return [dice[0]!, dice[1]!];
}
