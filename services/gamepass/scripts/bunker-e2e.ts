// Сквозной тест Бункера: поднимаем настоящий socket.io-сервер и подключаем
// несколько живых клиентов. Проверяем то, чего не видят юнит-тесты:
// реальные события, обрыв соединения, возврат и удержание места.

import { createServer } from "node:http";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import { Server as IOServer } from "socket.io";
import { signToken } from "../src/utils/jwt";
import { verifyToken } from "../src/utils/jwt";
import { registerBunkerSocket } from "../src/socket/bunker";

const PORT = 4599;
const URL = `http://localhost:${PORT}`;

interface BState {
  code: string;
  hostId: number;
  phase: string;
  round: number;
  voteResult: string | null;
  players: Array<{ userId: number; name: string; alive: boolean; online: boolean; bot: boolean; voted: boolean }>;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

class TestClient {
  socket: ClientSocket;
  state: BState | null = null;
  hand: Record<string, string> = {};
  events: string[] = [];
  errors: string[] = [];

  constructor(public userId: number, public name: string) {
    this.socket = connect(URL, {
      auth: { token: signToken({ userId, telegramId: String(userId) }) },
      transports: ["websocket"],
      forceNew: true,
    });
    this.socket.on("BUNKER_STATE", ({ state }: { state: BState }) => { this.state = state; });
    this.socket.on("BUNKER_HAND", ({ cards }: { cards: Record<string, string> }) => { this.hand = cards; });
    this.socket.on("BUNKER_EVENT", ({ text }: { text: string }) => { this.events.push(text); });
    this.socket.on("BUNKER_ERROR", ({ message }: { message: string }) => { this.errors.push(message); });
  }

  ready(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.connected) return resolve();
      this.socket.once("connect", () => resolve());
    });
  }

  me() {
    return this.state?.players.find((p) => p.userId === this.userId);
  }
}

async function main(): Promise<void> {
  const httpServer = createServer();
  const io = new IOServer(httpServer, { cors: { origin: true } });
  io.use((socket, next) => {
    const payload = verifyToken(socket.handshake.auth?.token as string);
    if (!payload) return next(new Error("invalid token"));
    (socket.data as any) = { userId: payload.userId, telegramId: payload.telegramId };
    next();
  });
  registerBunkerSocket(io);
  await new Promise<void>((r) => httpServer.listen(PORT, r));
  console.log(`сервер поднят на ${PORT}`);

  const host = new TestClient(101, "Хост");
  const guest = new TestClient(102, "Гость");
  const third = new TestClient(103, "Третий");
  await Promise.all([host.ready(), guest.ready(), third.ready()]);

  // --- Комната под паролем -------------------------------------------------
  host.socket.emit("BUNKER_CREATE", { code: "podval", name: "Хост", password: "1234" });
  await wait(200);
  check(host.state?.code === "PODVAL", "хост не попал в свою комнату");
  check(host.state?.hostId === 101, "создатель должен быть ведущим");

  guest.socket.emit("BUNKER_JOIN", { code: "podval", name: "Гость" });
  await wait(200);
  check(guest.errors.some((e) => e.includes("пароль")), "без пароля пускать нельзя");
  check(guest.state === null, "гость не должен видеть состояние комнаты");

  guest.socket.emit("BUNKER_JOIN", { code: "podval", name: "Гость", password: "1234" });
  third.socket.emit("BUNKER_JOIN", { code: "podval", name: "Третий", password: "1234" });
  await wait(300);
  check(guest.state?.players.length === 3, `в комнате должно быть трое, а не ${guest.state?.players.length}`);
  console.log("e2e: комната под паролем, вход втроём — ок");

  // --- Старт партии и раздача ---------------------------------------------
  guest.socket.emit("BUNKER_START");
  await wait(150);
  check(guest.errors.some((e) => e.includes("создатель")), "начать может только ведущий");

  host.socket.emit("BUNKER_START");
  await wait(300);
  check(host.state?.phase === "discuss", "после старта фаза обсуждения");
  check(Object.keys(host.hand).length === 8, "на руках должно быть восемь карт");
  check(Object.keys(guest.hand).length === 8, "гость тоже получает карты");
  check(host.hand.profession !== guest.hand.profession, "профессии игроков не должны совпадать");
  console.log("e2e: старт партии и личные карты — ок");

  // --- Раскрытие карты видно всем -----------------------------------------
  guest.socket.emit("BUNKER_REVEAL", { cat: "profession" });
  await wait(200);
  check(host.events.some((e) => e.includes(guest.hand.profession)), "раскрытая карта не долетела до других");
  check((host.state?.players.find((p) => p.userId === 102)?.voted ?? true) === false, "голосования ещё не было");
  console.log("e2e: раскрытие карты — ок");

  // --- Обрыв связи держит место -------------------------------------------
  guest.socket.disconnect();
  await wait(300);
  const offline = host.state?.players.find((p) => p.userId === 102);
  check(offline !== undefined, "выпавший игрок остаётся в составе");
  check(offline?.online === false, "выпавший должен показываться офлайн");

  const returned = new TestClient(102, "Гость");
  await returned.ready();
  returned.socket.emit("BUNKER_JOIN", { code: "podval", name: "Гость", password: "1234" });
  await wait(300);
  check(returned.state?.players.length === 3, "после возврата состав не должен меняться");
  check(returned.state?.players.find((p) => p.userId === 102)?.online === true, "вернувшийся снова онлайн");
  check(Object.keys(returned.hand).length === 8, "вернувшемуся заново приходят его карты");
  check(returned.hand.profession === guest.hand.profession, "карты после возврата должны быть теми же");
  console.log("e2e: обрыв связи, удержание места и возврат с теми же картами — ок");

  // --- Голосование ---------------------------------------------------------
  host.socket.emit("BUNKER_VOTE_START");
  await wait(200);
  check(host.state?.phase === "vote", "должна начаться фаза голосования");

  host.socket.emit("BUNKER_VOTE", { target: 103 });
  returned.socket.emit("BUNKER_VOTE", { target: 103 });
  await wait(200);
  check(third.state?.phase === "vote", "третий ещё не проголосовал — фаза не меняется");

  third.socket.emit("BUNKER_VOTE", { target: 101 }); // за себя нельзя — голосует за ведущего
  await wait(300);
  check(host.state?.phase === "discuss", "после всех голосов возвращаемся к обсуждению");
  const kicked = host.state?.players.find((p) => p.userId === 103);
  check(kicked?.alive === false, "изгнанный должен выбыть");
  check(host.state?.round === 2, "раунд должен вырасти");
  check((host.state?.voteResult || "").includes("изгнан"), "должен быть текст результата");
  console.log("e2e: голосование и изгнание — ок");

  // --- За себя голосовать нельзя ------------------------------------------
  host.socket.emit("BUNKER_VOTE_START");
  await wait(200);
  host.errors.length = 0;
  host.socket.emit("BUNKER_VOTE", { target: 101 });
  await wait(200);
  check(host.errors.some((e) => e.includes("не за себя")), "за себя голосовать нельзя");
  console.log("e2e: защита от голоса за себя — ок");

  [host, returned, third, guest].forEach((c) => c.socket.close());
  io.close();
  httpServer.close();
  console.log("Done.");
  process.exit(0);
}

main().catch((e) => {
  console.error("ПРОВАЛ:", e.message);
  process.exit(1);
});
