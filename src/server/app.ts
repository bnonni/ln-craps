import { Hono, type Context } from "hono";
import { serveStatic } from "hono/bun";
import { RuleError } from "../shared/craps";
import { HttpError, type Casino } from "./casino";
import { FakeLightning } from "./lightning";

type Env = { Variables: { accountId: string } };

const body = async (c: Context): Promise<Record<string, unknown>> => {
  const value = await c.req.json().catch(() => null);
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
};

export function createApp(casino: Casino, opts: { staticDir?: string } = {}) {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof RuleError) return c.json({ error: err.message }, 400);
    console.error(err);
    return c.json({ error: "Internal server error." }, 500);
  });

  app.post("/api/accounts", (c) => c.json(casino.createAccount(), 201));

  app.use("/api/*", async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const accountId = token ? casino.authenticate(token) : null;
    if (!accountId) return c.json({ error: "Unknown account key." }, 401);
    c.set("accountId", accountId);
    await next();
  });

  app.get("/api/me", (c) => c.json(casino.state(c.var.accountId)));

  app.put("/api/table", async (c) => c.json(casino.setTable(c.var.accountId, (await body(c)).layout)));

  app.post("/api/roll", async (c) => c.json(casino.roll(c.var.accountId, (await body(c)).layout)));

  app.get("/api/rolls", (c) => c.json({ rolls: casino.rolls(c.var.accountId, Number(c.req.query("limit") ?? 50)) }));

  app.post("/api/seeds/rotate", async (c) =>
    c.json(casino.rotateSeed(c.var.accountId, (await body(c)).clientSeed)),
  );

  app.post("/api/deposits", async (c) =>
    c.json(await casino.createDeposit(c.var.accountId, (await body(c)).amount), 201),
  );

  app.get("/api/deposits/:hash", async (c) => {
    const hash = c.req.param("hash");
    casino.deposit(c.var.accountId, hash);
    await casino.checkDeposit(hash).catch((e) => console.error("[deposit] check failed:", hash, e));
    return c.json(casino.deposit(c.var.accountId, hash));
  });

  app.post("/api/withdrawals", async (c) => c.json(await casino.withdraw(c.var.accountId, (await body(c)).bolt11)));

  app.get("/api/withdrawals/:hash", (c) => c.json(casino.withdrawal(c.var.accountId, c.req.param("hash"))));

  // Dev routes: only with the fake Lightning backend.
  const ln = casino.ln;
  if (ln instanceof FakeLightning) {
    app.post("/api/dev/deposits/:hash/pay", async (c) => {
      const hash = c.req.param("hash");
      casino.deposit(c.var.accountId, hash);
      ln.simulatePayment(hash);
      await casino.checkDeposit(hash);
      return c.json(casino.deposit(c.var.accountId, hash));
    });
    app.post("/api/dev/invoices", async (c) => {
      const amount = (await body(c)).amount;
      if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
        throw new HttpError(400, "The amount must be a whole number of sats, more than 0.");
      }
      return c.json({ bolt11: ln.externalInvoice(amount) });
    });
  }

  app.all("/api/*", (c) => c.json({ error: "Not found." }, 404));

  if (opts.staticDir) {
    const root = opts.staticDir;
    app.use("/*", serveStatic({ root }));
    app.get("*", serveStatic({ path: `${root}/index.html` }));
  } else {
    app.get("/", (c) =>
      c.text(
        "This port serves only /api in dev mode. Open the UI at http://localhost:5173.\n" +
          "For one port, run `bun run build`, then `bun run start`.\n",
      ),
    );
  }

  return app;
}
