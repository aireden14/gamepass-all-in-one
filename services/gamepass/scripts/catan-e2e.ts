// Сквозной тест Катана: живой socket.io-сервер и настоящая база (локальный Postgres
// из docker-compose, боевая Neon не трогается). Проверяем то, что не видит движок:
// подключение к партии, ход по сокету, отказ чужому, обрыв связи и возврат.
//
// Запуск: подними базу через `docker compose up -d postgres`, задай DATABASE_URL
// из docker-compose.yml и выполни `npx tsx scripts/catan-e2e.ts`.

import { createServer } from "node:http";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import { Server as IOServer } from "socket.io";
import { signToken, verifyToken } from "../src/utils/jwt";
import { registerCatanSocket } from "../src/socket/catan";
import { createGame, loadGame } from "../src/services/catanService";
import { prisma } from "../src/utils/prisma";
import { legalActions } from "../src/catan/engine";

const PORT = 4601;
const URL = `http://localhost:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

class TestClient {
  socket: ClientSocket;
  snapshot: any = null;
  states = 0;
  events: any[] = [];
  errors: string[] = [];

  constructor(public userId: number) {
    this.socket = connect(URL, {
      auth: { token: signToken({ userId, telegramId: String(userId) }) },
      transports: ["websocket"],
      forceNew: true,
    });
    this.socket.on("CATAN_STATE", ({ snapshot }: any) => { this.snapshot = snapshot; this.states += 1; });
    this.socket.on("CATAN_EVENT", ({ events }: any) => { this.events.push(...events); });
    this.socket.on("CATAN_ERROR", ({ message }: any) => { this.errors.push(message); });
  }

  ready(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.connected) return resolve();
      this.socket.once("connect", () => resolve());
    });
  }

  act(gameId: string, action: any): Promise<any> {
    return new Promise((resolve) => this.socket.emit("CATAN_ACTION", { gameId, action }, resolve));
  }
}

async function main(): Promise<void> {
  const gameId = `e2e${Date.now().toString(36)}`;
  const host = await prisma.user.upsert({
    where: { telegramId: BigInt(900001) },
    update: {},
    create: { telegramId: BigInt(900001), firstName: "Хост" },
  });
  const stranger = await prisma.user.upsert({
    where: { telegramId: BigInt(900002) },
    update: {},
    create: { telegramId: BigInt(900002), firstName: "Чужой" },
  });

  const httpServer = createServer();
  const io = new IOServer(httpServer, { cors: { origin: true } });
  io.use((socket, next) => {
    const payload = verifyToken(socket.handshake.auth?.token as string);
    if (!payload) return next(new Error("invalid token"));
    (socket.data as any) = { userId: payload.userId, telegramId: payload.telegramId };
    next();
  });
  registerCatanSocket(io);
  await new Promise<void>((r) => httpServer.listen(PORT, r));
  console.log(`сервер поднят на ${PORT}`);

  // Партия хоста и двух ботов — заполнена, значит стартует сразу.
  await createGame({
    gameId,
    hostUserId: host.id,
    maxPlayers: 3,
    botSeats: [{ seat: 1, level: "easy" }, { seat: 2, level: "easy" }],
  });
  const created = await loadGame(gameId);
  check(created !== null, "партия не создалась в базе");
  console.log("e2e: партия создана в базе — ок");

  const client = new TestClient(host.id);
  const other = new TestClient(stranger.id);
  await Promise.all([client.ready(), other.ready()]);

  client.socket.emit("CATAN_JOIN_ROOM", { gameId });
  await wait(900);
  check(client.snapshot !== null, "состояние партии не пришло по сокету");
  check(client.snapshot.state.phase.startsWith("SETUP"), `ожидали фазу расстановки, пришло ${client.snapshot.state.phase}`);
  console.log("e2e: вход в партию и первое состояние — ок");

  // Чужой не может ходить в этой партии.
  const denied = await other.act(gameId, { type: "BUILD_SETTLEMENT", vertexId: 0 });
  check(denied?.ok === false, "чужой не должен ходить в чужой партии");
  check(String(denied?.error).includes("participant"), `ожидали отказ участия, пришло ${denied?.error}`);
  console.log("e2e: чужому ход запрещён — ок");

  // Невалидный ход отклоняется движком, а не роняет сервер.
  const illegal = await client.act(gameId, { type: "ROLL_DICE" });
  check(illegal?.ok === false, "бросок кубика в фазе расстановки должен отклоняться");
  console.log("e2e: невалидный ход отклонён без падения — ок");

  // Настоящий ход: ставим деревню в разрешённую вершину.
  const before = await loadGame(gameId)!;
  const seat = (before as any).state.currentSeat;
  check(seat === 0, `первым ходит хост, а не место ${seat}`);
  const legal = legalActions((before as any).board, (before as any).state, seat)
    .filter((a: any) => a.type === "BUILD_SETTLEMENT");
  check(legal.length > 0, "движок не предложил ни одной деревни в фазе расстановки");
  const placed = await client.act(gameId, legal[0]);
  check(placed?.ok === true, `легальный ход отклонён: ${placed?.error}`);
  await wait(400);
  const after = await loadGame(gameId);
  const settlements = (after as any).state.players.reduce((n: number, p: any) => n + p.settlements.length, 0);
  check(settlements > 0, "деревня не сохранилась в базе");
  check(client.states > 1, "состояние не разослалось после хода");
  console.log(`e2e: ход по сокету сохранён в базе (деревень: ${settlements}) — ок`);

  // Обрыв связи: партия живёт в базе, при возврате состояние приходит заново.
  client.socket.disconnect();
  await wait(300);
  const back = new TestClient(host.id);
  await back.ready();
  back.socket.emit("CATAN_JOIN_ROOM", { gameId });
  await wait(900);
  check(back.snapshot !== null, "после возврата состояние не пришло");
  const settlementsBack = back.snapshot.state.players.reduce((n: number, p: any) => n + p.settlements.length, 0);
  check(settlementsBack === settlements, "после возврата партия должна быть той же");
  console.log("e2e: обрыв связи и возврат в ту же партию — ок");

  // Уборка
  [client, other, back].forEach((c) => c.socket.close());
  io.close();
  httpServer.close();
  await prisma.catanGame.delete({ where: { id: gameId } }).catch(() => undefined);
  await prisma.$disconnect();
  console.log("Done.");
  process.exit(0);
}

main().catch(async (e) => {
  console.error("ПРОВАЛ:", e.message);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
