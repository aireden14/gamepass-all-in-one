// Смоук общего мультиплеера настолок: состав стола, пароль, снапшоты,
// возврат в идущую партию и перенос роли ведущего.

import { RoomRegistry } from "../src/multiplayer/rooms";
import { TabletopState, normalizeSettings, isTabletopGame } from "../src/socket/tabletop";

const fakeSocket = (id: string) => ({ id, join: () => {} });
const fakeIo = { to: () => ({ emit: () => {} }) };

function makeRegistry(graceMs: number) {
  return new RoomRegistry<TabletopState>({
    channel: "tabletop-test",
    idPrefix: "TT",
    capacity: 6,
    graceMs,
    onSeatAbandoned: (room, _seat, userId) => {
      const s = room.state;
      if (s.phase === "lobby") s.players = s.players.filter((p) => p.userId !== userId);
      if (s.hostId === userId) {
        const heir = s.players.find(
          (p) => !p.bot && p.userId !== userId && room.connections.has(p.userId),
        );
        if (heir) s.hostId = heir.userId;
      }
    },
  });
}

const baseState = (hostId: number): TabletopState => ({
  game: "carcassonne",
  hostId,
  phase: "lobby",
  players: [],
  settings: normalizeSettings({ seats: 3, botFill: false, turnSeconds: 60 }),
  snapshot: null,
  turnIndex: 0,
  turnDeadline: null,
});

function checkSettings(): void {
  const wild = normalizeSettings({ seats: 99, botFill: "да", turnSeconds: 5 });
  if (wild.seats !== 6) throw new Error("мест не может быть больше шести");
  if (wild.botFill !== false) throw new Error("botFill принимает только true");
  if (wild.turnSeconds !== 15) throw new Error("таймер хода не может быть меньше 15 секунд");

  const off = normalizeSettings({ seats: 2, turnSeconds: 0 });
  if (off.turnSeconds !== 0) throw new Error("ноль означает игру без таймера");
  if (normalizeSettings({}).seats !== 2) throw new Error("по умолчанию стол на двоих");

  if (!isTabletopGame("carcassonne")) throw new Error("Каркассон должен быть в списке настолок");
  if (isTabletopGame("sudoku")) throw new Error("судоку не настолка со столом");
  console.log("tabletop: настройки стола — ок");
}

function checkTable(next: () => void): void {
  const registry = makeRegistry(40);
  const room = registry.create(1, baseState(1), "дом");
  room.state.players.push({ userId: 1, name: "Хост", bot: false });
  registry.join(room.id, 1, fakeSocket("h1") as any, "дом");

  if (registry.join(room.id, 2, fakeSocket("p2") as any)?.error !== "wrong_password") {
    throw new Error("стол под паролем не должен пускать без пароля");
  }
  const joined = registry.join(room.id, 2, fakeSocket("p2") as any, "дом");
  if (joined?.error !== null) throw new Error("верный пароль должен пускать");
  room.state.players.push({ userId: 2, name: "Гость", bot: false });

  // Партия пошла: ведущий публикует снапшот.
  room.state.phase = "playing";
  room.state.snapshot = JSON.stringify({ board: { "0,0": 1 }, cur: 0 });
  room.state.turnIndex = 1;

  // Гость вышел и вернулся — партия ждала его и отдаётся с текущего места.
  registry.detach(2, "p2", fakeIo as any);
  if (registry.seatOf(room, 2) === null) throw new Error("место должно держаться");
  const back = registry.join(room.id, 2, fakeSocket("p2b") as any);
  if (!back?.reconnected) throw new Error("возврат не распознан");
  if (!room.state.snapshot) throw new Error("снапшот должен пережить выход игрока");
  if (room.state.turnIndex !== 1) throw new Error("очередь хода не должна сбрасываться");
  console.log("tabletop: пароль, возврат и сохранение партии — ок");

  // Ведущий отвалился насовсем — роль уходит оставшемуся игроку.
  registry.detach(1, "h1", fakeIo as any);
  if (room.state.hostId !== 1) throw new Error("роль не должна уходить сразу — сначала ждём");
  setTimeout(() => {
    if (room.state.hostId !== 2) throw new Error("ведущий не сменился после истечения окна");
    if (room.state.snapshot === null) throw new Error("партия не должна теряться при смене ведущего");
    console.log("tabletop: перенос роли ведущего — ок");
    next();
  }, 90);
}

function checkSeats(): void {
  const registry = makeRegistry(1000);
  const room = registry.create(1, baseState(1));
  room.state.players.push({ userId: 1, name: "Хост", bot: false });
  registry.join(room.id, 1, fakeSocket("h") as any);

  // Добор ботами до трёх мест.
  let botIndex = 1;
  while (room.state.players.length < room.state.settings.seats) {
    if (!registry.claimSeat(room, -botIndex)) throw new Error("бот не сел за стол");
    room.state.players.push({ userId: -botIndex, name: `Бот-${botIndex}`, bot: true });
    botIndex += 1;
  }
  if (room.state.players.length !== 3) throw new Error("стол должен добраться до трёх мест");
  if (room.state.players.filter((p) => p.bot).length !== 2) throw new Error("ожидали двух ботов");

  // Больше шести за столом не сядет.
  for (let u = 10; u < 20; u += 1) registry.join(room.id, u, fakeSocket(`u${u}`) as any);
  if (registry.occupiedSeats(room).length !== 6) throw new Error("за столом максимум шесть мест");
  console.log("tabletop: добор ботами и лимит мест — ок");
}

checkSettings();
checkSeats();
checkTable(() => {
  console.log("Done.");
  process.exit(0);
});
