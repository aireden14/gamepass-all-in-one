import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { authRouter } from "./routes/auth";
import { usersRouter } from "./routes/users";
import { gamesRouter } from "./routes/games";
import { sudokuRouter } from "./routes/sudoku";
import { beatsRouter } from "./routes/beats";
import { catanRouter } from "./routes/catan";
import { telegramWebhookRouter } from "./routes/telegramWebhook";
import { prisma } from "./utils/prisma";
import { initSocket, startTimerWatchdog } from "./socket";

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res
    .type("text/plain")
    .send(`Chess backend is running! ${process.env.RENDER_GIT_COMMIT || "local"} ${new Date().toISOString()}`);
});
app.get("/api/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: "connected", t: Date.now() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});
app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/games", gamesRouter);
app.use("/api/sudoku", sudokuRouter);
app.use("/api/beats", beatsRouter);
app.use("/api/catan", catanRouter);
app.use("/api/telegram", telegramWebhookRouter);

app.use((err: any, _req: any, res: any, _next: any) => {
  console.error("[express error]", err);
  res.status(500).json({ error: err?.message || "server error" });
});

const port = Number(process.env.PORT || 3001);
const httpServer = createServer(app);
initSocket(httpServer, "");
startTimerWatchdog();

httpServer.listen(port, () => {
  console.log(`[chess] backend on :${port}`);
});
