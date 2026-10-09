// Provably fair dice. This file uses only Web Crypto, so the browser can verify each roll.
//
// Procedure:
//   1. Before play, the server shows hash = SHA-256(serverSeed).
//   2. The player sets a clientSeed.
//   3. For roll number `nonce`, round r = 0, 1, 2, ...:
//        bytes = HMAC-SHA512(key = serverSeed, message = `${clientSeed}:${nonce}:${r}`)
//      Read the bytes in order. Reject each byte >= 252. Each other byte gives a die: (byte % 6) + 1.
//      Stop when there are two dice. (Round 0 almost always gives them.)
//   4. When the player rotates the seeds, the server shows the old serverSeed.
//
// 252 is the largest multiple of 6 that is less than 256. Thus each face has a probability of exactly 1/6.
// The serverSeed is a hex string. Both the HMAC key and the hash input are the UTF-8 bytes of that string.

import type { Dice } from "./craps";

export const BYTE_LIMIT = 252;

export const rollMessage = (clientSeed: string, nonce: number, round: number) => `${clientSeed}:${nonce}:${round}`;

/** Add dice from the bytes to `dice` until there are two. */
export function takeDice(bytes: Uint8Array, dice: number[]): void {
  for (const b of bytes) {
    if (dice.length === 2) return;
    if (b < BYTE_LIMIT) dice.push((b % 6) + 1);
  }
}

const utf8 = new TextEncoder();

export const toHex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", utf8.encode(text)));
}

/** Calculate the dice for one roll. The browser uses this function to verify the server. */
export async function rollDice(serverSeed: string, clientSeed: string, nonce: number): Promise<Dice> {
  const key = await crypto.subtle.importKey("raw", utf8.encode(serverSeed), { name: "HMAC", hash: "SHA-512" }, false, [
    "sign",
  ]);
  const dice: number[] = [];
  for (let round = 0; dice.length < 2; round++) {
    const mac = await crypto.subtle.sign("HMAC", key, utf8.encode(rollMessage(clientSeed, nonce, round)));
    takeDice(new Uint8Array(mac), dice);
  }
  return [dice[0]!, dice[1]!];
}

export interface VerifyInput {
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  dice: Dice;
}

/** Returns true if the revealed seed matches its hash and gives the same dice. */
export async function verifyRoll(input: VerifyInput): Promise<boolean> {
  if ((await sha256Hex(input.serverSeed)) !== input.serverSeedHash) return false;
  const dice = await rollDice(input.serverSeed, input.clientSeed, input.nonce);
  return dice[0] === input.dice[0] && dice[1] === input.dice[1];
}
