// Хедлесс-смоук Бункера: партии ботами в чистом движке + проверки ядра комнат
// на составе до 12 игроков (свои коды, хост, боты, удержание места).

import {
  BunkerState, CARD_CATS, assignBotVotes, dealCards, initialState, makePlayer,
  revealBotCards, tallyVotes,
} from "../src/bunker/engine";
import { RoomRegistry } from "../src/multiplayer/rooms";

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

interface GameResult {
  rounds: number;
  survivors: number;
}

function playGame(seed: number, botCount: number, maxRounds = 60): GameResult {
  const rng = makeRng(seed);
  const state: BunkerState = initialState(1);
  state.players.push(makePlayer(1, "Человек"));
  for (let i = 0; i < botCount; i += 1) state.players.push(makePlayer(-1 - i, `Бот-${i + 1}`, true));

  dealCards(state, rng);
  state.phase = "discuss";
  state.round = 1;

  let rounds = 0;
  while (state.players.filter((p) => p.alive).length > 2 && rounds < maxRounds) {
    state.phase = "vote";
    state.players.forEach((p) => { p.vote = null; });
    revealBotCards(state, 1, rng);
    assignBotVotes(state, rng);

    // Человек голосует за случайного живого, кроме себя.
    const human = state.players.find((p) => !p.bot)!;
    if (human.alive) {
      const pool = state.players.filter((p) => p.alive && p.userId !== human.userId);
      human.vote = pool.length ? pool[Math.floor(rng() * pool.length)].userId : null;
    }

    const aliveBefore = state.players.filter((p) => p.alive).length;
    const { eliminated } = tallyVotes(state);
    const aliveAfter = state.players.filter((p) => p.alive).length;

    if (eliminated && aliveAfter !== aliveBefore - 1) {
      throw new Error(`изгнан один, а живых стало ${aliveAfter} из ${aliveBefore}: seed=${seed}`);
    }
    if (eliminated && eliminated.revealed.size !== CARD_CATS.length) {
      throw new Error(`изгнанный должен вскрыть все карты: seed=${seed}`);
    }
    if (!eliminated && aliveAfter !== aliveBefore) {
      throw new Error(`ничья не должна никого убивать: seed=${seed}`);
    }
    if (state.phase !== "discuss") throw new Error(`после подсчёта ждём discuss: seed=${seed}`);
    if (state.players.some((p) => p.vote !== null)) throw new Error(`голоса не сброшены: seed=${seed}`);

    rounds += 1;
  }
  return { rounds, survivors: state.players.filter((p) => p.alive).length };
}

function checkCards(): void {
  const state = initialState(1);
  for (let i = 0; i < 8; i += 1) state.players.push(makePlayer(i + 1, `И-${i + 1}`));
  dealCards(state, makeRng(4242));

  const professions = state.players.map((p) => p.cards.profession);
  if (new Set(professions).size !== professions.length) throw new Error("профессии не должны повторяться");
  state.players.forEach((p) => {
    for (const cat of CARD_CATS) {
      if (!p.cards[cat]) throw new Error(`не роздана карта ${cat}`);
    }
    if (p.revealed.size !== 0) throw new Error("после раздачи карты закрыты");
  });
  if (!state.scenario || !state.bunker) throw new Error("не выбран сценарий или бункер");
  console.log("bunker engine: раздача карт — ок");
}

// --- Ядро комнат на составе Бункера ---------------------------------------

const fakeSocket = (id: string) => ({ id, join: () => {} });
const fakeIo = { to: () => ({ emit: () => {} }) };

function checkRoomCore(next: () => void): void {
  const abandoned: number[] = [];
  const registry = new RoomRegistry<{ tag: string }>({
    channel: "bunker-test",
    idPrefix: "BK",
    capacity: 12,
    graceMs: 40,
    onSeatAbandoned: (_room, _seat, userId) => abandoned.push(userId),
  });

  // Свой код комнаты, как в Бункере.
  const room = registry.create(1, { tag: "x" }, "тайна", { id: "podval" });
  if (room.id !== "PODVAL") throw new Error("код комнаты должен нормализоваться");
  registry.join(room.id, 1, fakeSocket("h1") as any, "тайна");

  if (registry.join(room.id, 2, fakeSocket("p2") as any)?.error !== "wrong_password") {
    throw new Error("комната под паролем не должна пускать без него");
  }
  if (registry.join(room.id, 2, fakeSocket("p2") as any, "тайна")?.error !== null) {
    throw new Error("верный пароль должен пускать");
  }

  // Боты занимают места без сокетов.
  for (let i = 0; i < 5; i += 1) {
    if (!registry.claimSeat(room, -1 - i)) throw new Error("бот не получил место");
  }
  if (registry.occupiedSeats(room).length !== 7) throw new Error("ожидали 7 занятых мест");

  // Переполнение на 12.
  for (let u = 3; u <= 7; u += 1) registry.join(room.id, u, fakeSocket(`u${u}`) as any, "тайна");
  const overflow = registry.join(room.id, 99, fakeSocket("u99") as any, "тайна");
  if (overflow?.seat !== null) throw new Error("13-й игрок не должен получать место");
  console.log("bunker rooms: свой код, пароль, боты и лимит 12 — ок");

  // Личные сокеты для карт на руках: две вкладки одного игрока.
  registry.join(room.id, 2, fakeSocket("p2-tab2") as any);
  if (registry.socketsOf(room, 2).length !== 2) throw new Error("обе вкладки игрока должны получать карты");

  // Обрыв одной вкладки не считается выходом.
  registry.detach(2, "p2", fakeIo as any);
  if (!registry.isUserOnline(room, 2)) throw new Error("игрок с живой второй вкладкой остаётся онлайн");

  registry.detach(2, "p2-tab2", fakeIo as any);
  if (registry.isUserOnline(room, 2)) throw new Error("после закрытия всех вкладок игрок оффлайн");
  if (registry.seatOf(room, 2) === null) throw new Error("место держится 2 минуты, а не сбрасывается сразу");

  // Добровольный выход освобождает место сразу.
  registry.release(room, 3);
  if (registry.seatOf(room, 3) !== null) throw new Error("после выхода место должно освободиться");
  console.log("bunker rooms: вкладки, обрыв и добровольный выход — ок");

  setTimeout(() => {
    if (registry.seatOf(room, 2) !== null) throw new Error("место не освободилось после окна");
    if (!abandoned.includes(2)) throw new Error("не сработал onSeatAbandoned");
    console.log("bunker rooms: освобождение места после окна — ок");
    next();
  }, 90);
}

function runGames(): void {
  const games = Number(process.argv[2] || 100);
  let finished = 0;
  let maxRounds = 0;
  for (let i = 0; i < games; i += 1) {
    const r = playGame(1337 + i * 17, 3 + (i % 6));
    if (r.survivors === 2) finished += 1;
    maxRounds = Math.max(maxRounds, r.rounds);
  }
  console.log(`bunker selfplay: ${finished}/${games} партий дошли до двух выживших, максимум ${maxRounds} раундов`);
  if (finished < games) {
    console.error("часть партий зависла — голосование не сходится");
    process.exit(1);
  }
  console.log("Done.");
  process.exit(0);
}

checkCards();
checkRoomCore(runGames);
