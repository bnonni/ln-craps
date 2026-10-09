import { existsSync } from "node:fs";
import { createApp } from "./app";
import { Casino } from "./casino";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { createLightning } from "./lightning";

const config = loadConfig();
const db = openDb(config.databasePath);
const ln = createLightning(config);
const casino = new Casino(db, config, ln);

const staticDir = process.env.NODE_ENV === "production" && existsSync("dist/index.html") ? "dist" : undefined;
const app = createApp(casino, { staticDir });

/** Run a task again and again, with a pause between two runs. Runs never overlap. */
function every(ms: number, name: string, task: () => Promise<void>): void {
  const run = async () => {
    try {
      await task();
    } catch (e) {
      console.error(`[${name}]`, e);
    }
    setTimeout(run, ms);
  };
  void run();
}

every(2_000, "deposits", () => casino.syncDeposits());
every(15_000, "withdrawals", () => casino.syncWithdrawals());

const server = Bun.serve({ port: config.port, fetch: app.fetch });
console.log(`ln-craps: http://localhost:${server.port} (Lightning backend: ${ln.name}, database: ${config.databasePath})`);
if (ln.name === "fake") console.log("ln-craps: the fake backend moves no real money. The /api/dev routes are on.");
