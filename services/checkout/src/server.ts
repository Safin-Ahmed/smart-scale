import "./tracing";
import express from "express";

const app = express();

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.post("/checkout", async (_req, res) => {
  const start = Date.now();

  // CPU Work
  const spinMs = Number("20");
  const end = Date.now() + spinMs;
  let x = 0;

  while (Date.now() < end) x = (x * 3 + 1) % 1000003;

  // Latency

  const base = Number("30");
  const jitter = Number("50");
  const sleep = base + Math.floor(Math.random() * jitter);

  await new Promise((r) => setTimeout(r, sleep));

  // Errors
  const errorRate = Number("0.01");

  if (Math.random() < errorRate)
    return res.status(500).json({ error: "checkout failed" });

  res.json({ status: "ok", ms: Date.now() - start });
});

const port = 8080;

async function main() {
  app.listen(port, () => {
    console.log(`Checkout service listening on port ${port}`);
  });
}

main().catch((error) => {
  console.error("Error starting server:", error);
  process.exit(1);
});
