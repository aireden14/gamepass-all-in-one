import { Router, Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { prisma } from "../utils/prisma";
import { verifyToken } from "../utils/jwt";

// BurpiOpus: общий дневник для веба (GamePass) и Apple Watch.
//
// Веб приходит с обычным JWT GamePass, часы — с собственным токеном
// `Authorization: Watch <token>`, который выдаётся один раз по 6-значному коду
// из настроек веба. Записи — это сессии дневника как есть (JSON), ключ —
// клиентский id. Удаление не стирает строку, а ставит `deleted`, чтобы другое
// устройство не вернуло удалённую тренировку при следующей отправке.
export const burpiOpusRouter = Router();

type Caller = { userId: number; via: "web" | "watch" };
interface BurpiRequest extends Request {
  caller?: Caller;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ENTRY_JSON = 8_000;
const MAX_CONFIG_JSON = 40_000;
const MAX_ENTRIES_PER_SYNC = 500;
const PAGE = 1000;
// Запись, начатая раньше, может закоммититься позже соседней — поэтому курсор
// отдаём с запасом назад. Слияние на клиенте идемпотентно, повтор безвреден.
const CURSOR_OVERLAP_MS = 5_000;
const PAIR_TTL_MS = 10 * 60 * 1000;

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function callerAuth(req: BurpiRequest, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization || "";
    if (header.startsWith("Bearer ")) {
      const payload = verifyToken(header.slice(7));
      if (!payload) return res.status(401).json({ error: "invalid token" });
      req.caller = { userId: payload.userId, via: "web" };
      return next();
    }
    if (header.startsWith("Watch ")) {
      const token = header.slice(6).trim();
      const link = token ? await prisma.burpiWatchLink.findUnique({ where: { tokenHash: hashToken(token) } }) : null;
      if (!link) return res.status(401).json({ error: "watch not linked" });
      void prisma.burpiWatchLink
        .update({ where: { id: link.id }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined);
      req.caller = { userId: link.userId, via: "watch" };
      return next();
    }
    return res.status(401).json({ error: "missing token" });
  } catch (error) {
    return next(error);
  }
}

function webOnly(req: BurpiRequest, res: Response, next: NextFunction) {
  if (req.caller?.via !== "web") return res.status(403).json({ error: "web only" });
  return next();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ состояние */

// GET /api/burpi-opus/state?since=<ms> — записи, изменённые после курсора, и
// общие настройки (уровни, пояс, граница суток живут в вебе).
burpiOpusRouter.get("/state", callerAuth, async (req: BurpiRequest, res: Response) => {
  const userId = req.caller!.userId;
  const sinceRaw = Number(req.query.since);
  const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;

  const rows = await prisma.burpiOpusEntry.findMany({
    where: { userId, updatedAt: { gte: new Date(since) } },
    orderBy: { updatedAt: "asc" },
    take: PAGE,
  });
  const more = rows.length === PAGE;
  const last = rows.length ? rows[rows.length - 1].updatedAt.getTime() : since;
  const cursor = more ? last : Math.max(0, last - CURSOR_OVERLAP_MS);

  const profile = await prisma.burpiOpusProfile.findUnique({ where: { userId } });

  res.json({
    entries: rows.map((r) => ({
      id: r.clientId,
      deleted: r.deleted,
      source: r.source,
      updatedAt: r.updatedAt.getTime(),
      data: r.deleted ? null : parseJson(r.dataJson),
    })),
    cursor,
    more,
    config: profile ? parseJson(profile.configJson) : null,
    configUpdatedAt: profile ? profile.updatedAt.getTime() : null,
    serverTime: Date.now(),
  });
});

// POST /api/burpi-opus/sync — { entries: [{id, data?, deleted?}], config? }.
// Настройки принимаются только от веба: часы их лишь читают.
burpiOpusRouter.post("/sync", callerAuth, async (req: BurpiRequest, res: Response) => {
  const { userId, via } = req.caller!;
  const body = req.body || {};
  const incoming: unknown[] = Array.isArray(body.entries) ? body.entries : [];
  if (incoming.length > MAX_ENTRIES_PER_SYNC) {
    return res.status(400).json({ error: "too many entries" });
  }

  let accepted = 0;
  let latestDay: string | null = null;
  for (const raw of incoming) {
    const item = raw as { id?: unknown; data?: unknown; deleted?: unknown };
    if (typeof item?.id !== "string" || !ID_RE.test(item.id)) continue;
    const clientId = item.id;
    const where = { userId_clientId: { userId, clientId } };

    if (item.deleted === true) {
      await prisma.burpiOpusEntry.upsert({
        where,
        update: { deleted: true },
        create: { userId, clientId, dataJson: "{}", dayKey: "", deleted: true, source: via },
      });
      accepted += 1;
      continue;
    }

    if (!item.data || typeof item.data !== "object" || Array.isArray(item.data)) continue;
    const dataJson = JSON.stringify(item.data);
    if (dataJson.length > MAX_ENTRY_JSON) continue;
    const dayRaw = (item.data as { dayKey?: unknown }).dayKey;
    const dayKey = typeof dayRaw === "string" && DAY_RE.test(dayRaw) ? dayRaw : "";

    await prisma.burpiOpusEntry.upsert({
      where,
      update: { dataJson, dayKey, deleted: false },
      create: { userId, clientId, dataJson, dayKey, source: via },
    });
    accepted += 1;
    if (dayKey && (!latestDay || dayKey > latestDay)) latestDay = dayKey;
  }

  if (body.config !== undefined && via === "web") {
    if (body.config && typeof body.config === "object" && !Array.isArray(body.config)) {
      const configJson = JSON.stringify(body.config);
      if (configJson.length <= MAX_CONFIG_JSON) {
        await prisma.burpiOpusProfile.upsert({
          where: { userId },
          update: { configJson },
          create: { userId, configJson },
        });
      }
    }
  }

  // Тренировка с часов закрывает день для Telegram-напоминаний так же, как
  // веб делает это через /burpi-reminders/complete.
  if (via === "watch" && latestDay) {
    const current = await prisma.burpiReminder.findUnique({ where: { userId } });
    if (!current?.completedDateKey || current.completedDateKey < latestDay) {
      await prisma.burpiReminder.upsert({
        where: { userId },
        update: { completedDateKey: latestDay },
        create: { userId, completedDateKey: latestDay },
      });
    }
  }

  res.json({ ok: true, accepted, serverTime: Date.now() });
});

/* --------------------------------------------------------- привязка часов */

// POST /api/burpi-opus/pair-code — одноразовый код для часов, живёт 10 минут.
burpiOpusRouter.post("/pair-code", callerAuth, webOnly, async (req: BurpiRequest, res: Response) => {
  const userId = req.caller!.userId;
  await prisma.burpiPairCode.deleteMany({
    where: { OR: [{ userId }, { expiresAt: { lt: new Date() } }] },
  });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const taken = await prisma.burpiPairCode.findUnique({ where: { code } });
    if (taken) continue;
    const expiresAt = new Date(Date.now() + PAIR_TTL_MS);
    await prisma.burpiPairCode.create({ data: { code, userId, expiresAt } });
    return res.json({ code, expiresAt: expiresAt.getTime() });
  }
  return res.status(503).json({ error: "try again" });
});

// Код из 6 цифр перебирается, если не ограничивать попытки. Счётчик в памяти
// процесса: на одном контейнере этого достаточно, после рестарта — с нуля.
const failures = new Map<string, { count: number; resetAt: number }>();
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_LIMIT_PER_IP = 10;
let globalFailures = { count: 0, resetAt: 0 };
const FAIL_LIMIT_GLOBAL = 60;

function clientIp(req: Request) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.ip || "unknown";
}

function isThrottled(ip: string) {
  const now = Date.now();
  const entry = failures.get(ip);
  if (entry && entry.resetAt < now) failures.delete(ip);
  if (globalFailures.resetAt < now) globalFailures = { count: 0, resetAt: now + FAIL_WINDOW_MS };
  return (failures.get(ip)?.count ?? 0) >= FAIL_LIMIT_PER_IP || globalFailures.count >= FAIL_LIMIT_GLOBAL;
}

function noteFailure(ip: string) {
  const now = Date.now();
  const entry = failures.get(ip);
  if (!entry || entry.resetAt < now) failures.set(ip, { count: 1, resetAt: now + FAIL_WINDOW_MS });
  else entry.count += 1;
  globalFailures.count += 1;
}

// POST /api/burpi-opus/pair — { code, device? } → { token }. Без авторизации:
// именно так часы и получают свой постоянный токен.
burpiOpusRouter.post("/pair", async (req: Request, res: Response) => {
  const ip = clientIp(req);
  if (isThrottled(ip)) return res.status(429).json({ error: "too many attempts" });

  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  if (!/^\d{6}$/.test(code)) {
    const info = `bad body type=${typeof req.body?.code} len=${code.length} ctype=${req.headers["content-type"] || ""}`;
    await prisma.burpiPairMiss.create({ data: { info } }).catch(() => undefined);
    noteFailure(ip);
    return res.status(400).json({ error: "bad code" });
  }

  const row = await prisma.burpiPairCode.findUnique({ where: { code } });
  if (!row || row.expiresAt.getTime() < Date.now()) {
    // Для разбора неудачных привязок: сам код не пишем, только его форму.
    const live = await prisma.burpiPairCode.count({ where: { expiresAt: { gt: new Date() } } });
    const info = `code=${code.slice(0, 2)}**** len=${code.length} expired=${Boolean(row)} live=${live} ua=${String(req.headers["user-agent"] || "").slice(0, 80)}`;
    await prisma.burpiPairMiss.create({ data: { info } }).catch(() => undefined);
    noteFailure(ip);
    return res.status(404).json({ error: "code not found" });
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const device = typeof req.body?.device === "string" ? req.body.device.slice(0, 60) : "";
  await prisma.$transaction([
    prisma.burpiPairCode.delete({ where: { code } }),
    prisma.burpiWatchLink.create({ data: { userId: row.userId, tokenHash: hashToken(token), device } }),
  ]);
  const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { firstName: true } });
  return res.json({ token, name: user?.firstName ?? "" });
});

// GET /api/burpi-opus/watch-links — сколько часов привязано (для настроек веба).
burpiOpusRouter.get("/watch-links", callerAuth, webOnly, async (req: BurpiRequest, res: Response) => {
  const links = await prisma.burpiWatchLink.findMany({
    where: { userId: req.caller!.userId },
    orderBy: { lastSeenAt: "desc" },
    select: { device: true, createdAt: true, lastSeenAt: true },
  });
  res.json({
    links: links.map((l) => ({
      device: l.device,
      createdAt: l.createdAt.getTime(),
      lastSeenAt: l.lastSeenAt.getTime(),
    })),
  });
});

// DELETE /api/burpi-opus/watch-links — отвязать все часы разом.
burpiOpusRouter.delete("/watch-links", callerAuth, webOnly, async (req: BurpiRequest, res: Response) => {
  const { count } = await prisma.burpiWatchLink.deleteMany({ where: { userId: req.caller!.userId } });
  res.json({ ok: true, removed: count });
});

/* ------------------------------------------------------ пульт суфлёра */

// Часы шлют команды, Суфлёр.app на Маке забирает их длинным опросом. Всё в
// памяти процесса: команды живут секунды, после рестарта терять нечего.
type RemoteCmd = { id: number; cmd: string; value: number; at: number };
const REMOTE_CMDS = new Set(["toggle", "play", "pause", "speed", "scroll", "para", "top"]);
const REMOTE_TTL_MS = 30_000;
const REMOTE_POLL_MS = 20_000;
const remoteQueues = new Map<number, RemoteCmd[]>();
const remoteWaiters = new Map<number, Set<() => void>>();
const remoteStates = new Map<number, { speed: number; playing: boolean; title: string; at: number }>();
let remoteSeq = 0;

function remoteFresh(userId: number) {
  const now = Date.now();
  const queue = (remoteQueues.get(userId) || []).filter((c) => now - c.at < REMOTE_TTL_MS);
  remoteQueues.set(userId, queue);
  return queue;
}

// POST /api/burpi-opus/remote — { cmd, value? } с часов.
burpiOpusRouter.post("/remote", callerAuth, (req: BurpiRequest, res: Response) => {
  const userId = req.caller!.userId;
  const cmd = String(req.body?.cmd || "");
  if (!REMOTE_CMDS.has(cmd)) return res.status(400).json({ error: "bad cmd" });
  const raw = Number(req.body?.value);
  const value = Number.isFinite(raw) ? Math.max(-5000, Math.min(5000, raw)) : 0;
  const queue = remoteFresh(userId);
  queue.push({ id: ++remoteSeq, cmd, value, at: Date.now() });
  if (queue.length > 50) queue.splice(0, queue.length - 50);
  remoteWaiters.get(userId)?.forEach((wake) => wake());
  res.json({ ok: true, mac: remoteStates.has(userId) && Date.now() - remoteStates.get(userId)!.at < 60_000 });
});

// GET /api/burpi-opus/remote/poll?after=<id> — Суфлёр ждёт команды до 20 с.
burpiOpusRouter.get("/remote/poll", callerAuth, (req: BurpiRequest, res: Response) => {
  const userId = req.caller!.userId;
  // После рестарта сервера счёт команд начинается заново — курсор из будущего
  // сбрасываем, иначе Суфлёр не увидит ни одной новой команды.
  const requested = Number(req.query.after) || 0;
  const after = requested > remoteSeq ? 0 : requested;
  const pick = () => remoteFresh(userId).filter((c) => c.id > after);
  const ready = pick();
  if (ready.length) return res.json({ cmds: ready, last: ready[ready.length - 1].id });

  const waiters = remoteWaiters.get(userId) || new Set<() => void>();
  remoteWaiters.set(userId, waiters);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    waiters.delete(finish);
    const cmds = pick();
    res.json({ cmds, last: cmds.length ? cmds[cmds.length - 1].id : Math.max(after, remoteSeq) });
  };
  const timer = setTimeout(finish, REMOTE_POLL_MS);
  waiters.add(finish);
  req.on("close", () => {
    done = true;
    clearTimeout(timer);
    waiters.delete(finish);
  });
});

// POST /api/burpi-opus/remote/state — Суфлёр сообщает скорость и что открыто.
burpiOpusRouter.post("/remote/state", callerAuth, (req: BurpiRequest, res: Response) => {
  const speed = Math.max(1, Math.min(100, Number(req.body?.speed) || 22));
  const playing = req.body?.playing === true;
  const title = String(req.body?.title || "").slice(0, 80);
  remoteStates.set(req.caller!.userId, { speed, playing, title, at: Date.now() });
  res.json({ ok: true });
});

// GET /api/burpi-opus/remote/state — часы узнают, на связи ли Мак.
burpiOpusRouter.get("/remote/state", callerAuth, (req: BurpiRequest, res: Response) => {
  const state = remoteStates.get(req.caller!.userId);
  const online = !!state && Date.now() - state.at < 60_000;
  res.json({ online, speed: state?.speed ?? 22, playing: state?.playing ?? false, title: state?.title ?? "" });
});

/* ---------------------------------------------------- пульт сериалов */

// Второй пульт на часах — для сериалов на Маке (Torrent Player или видео в
// Chrome). Команды забирает tg-mac-agent тем же длинным опросом, что и Суфлёр.
type TvCmd = { id: number; cmd: string; value: number; at: number };
type TvState = { source: string; title: string; playing: boolean; volume: number; at: number };
const TV_CMDS = new Set(["toggle", "seek", "volume", "next", "prev", "fullscreen"]);
const tvQueues = new Map<number, TvCmd[]>();
const tvWaiters = new Map<number, Set<() => void>>();
const tvStates = new Map<number, TvState>();
let tvSeq = 0;

function tvFresh(userId: number) {
  const now = Date.now();
  const queue = (tvQueues.get(userId) || []).filter((c) => now - c.at < REMOTE_TTL_MS);
  tvQueues.set(userId, queue);
  return queue;
}

// POST /api/burpi-opus/tv — { cmd, value? } с часов.
burpiOpusRouter.post("/tv", callerAuth, (req: BurpiRequest, res: Response) => {
  const userId = req.caller!.userId;
  const cmd = String(req.body?.cmd || "");
  if (!TV_CMDS.has(cmd)) return res.status(400).json({ error: "bad cmd" });
  const raw = Number(req.body?.value);
  const value = Number.isFinite(raw) ? Math.max(-3600, Math.min(3600, raw)) : 0;
  const queue = tvFresh(userId);
  queue.push({ id: ++tvSeq, cmd, value, at: Date.now() });
  if (queue.length > 50) queue.splice(0, queue.length - 50);
  tvWaiters.get(userId)?.forEach((wake) => wake());
  res.json({ ok: true });
});

// GET /api/burpi-opus/tv/poll?after=<id> — Мак ждёт команды до 20 с.
burpiOpusRouter.get("/tv/poll", callerAuth, (req: BurpiRequest, res: Response) => {
  const userId = req.caller!.userId;
  const requested = Number(req.query.after) || 0;
  const after = requested > tvSeq ? 0 : requested;
  const pick = () => tvFresh(userId).filter((c) => c.id > after);
  const ready = pick();
  if (ready.length) return res.json({ cmds: ready, last: ready[ready.length - 1].id });

  const waiters = tvWaiters.get(userId) || new Set<() => void>();
  tvWaiters.set(userId, waiters);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    waiters.delete(finish);
    const cmds = pick();
    res.json({ cmds, last: cmds.length ? cmds[cmds.length - 1].id : Math.max(after, tvSeq) });
  };
  const timer = setTimeout(finish, REMOTE_POLL_MS);
  waiters.add(finish);
  req.on("close", () => {
    done = true;
    clearTimeout(timer);
    waiters.delete(finish);
  });
});

// POST /api/burpi-opus/tv/state — Мак сообщает, что сейчас играет.
burpiOpusRouter.post("/tv/state", callerAuth, (req: BurpiRequest, res: Response) => {
  const source = ["torrent", "browser"].includes(req.body?.source) ? String(req.body.source) : "none";
  tvStates.set(req.caller!.userId, {
    source,
    title: String(req.body?.title || "").slice(0, 80),
    playing: req.body?.playing === true,
    volume: Math.max(0, Math.min(100, Number(req.body?.volume) || 0)),
    at: Date.now(),
  });
  res.json({ ok: true });
});

// GET /api/burpi-opus/tv/state — часы узнают, на связи ли Мак и что играет.
burpiOpusRouter.get("/tv/state", callerAuth, (req: BurpiRequest, res: Response) => {
  const state = tvStates.get(req.caller!.userId);
  const online = !!state && Date.now() - state.at < 60_000;
  res.json({
    online,
    source: online ? state!.source : "none",
    title: online ? state!.title : "",
    playing: online ? state!.playing : false,
    volume: state?.volume ?? 0,
  });
});

/* ------------------------------------------------------------ друзья */

const FRIEND_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// Сутки BurpiOpus начинаются в 05:00; пояс друзей почти всегда Кипр — берём его.
function burpiDayKey(offsetDays = 0) {
  const shifted = new Date(Date.now() - 5 * 3600_000 + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Nicosia" }).format(shifted);
}

async function friendCodeFor(userId: number) {
  const existing = await prisma.burpiFriendCode.findUnique({ where: { userId } });
  if (existing) return existing.code;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = Array.from(crypto.randomBytes(6), (b) => FRIEND_ALPHABET[b % FRIEND_ALPHABET.length]).join("");
    const taken = await prisma.burpiFriendCode.findUnique({ where: { code } });
    if (taken) continue;
    await prisma.burpiFriendCode.create({ data: { code, userId } });
    return code;
  }
  throw new Error("friend code");
}

async function weekSummary(userId: number) {
  const since = burpiDayKey(-6);
  const today = burpiDayKey();
  const rows = await prisma.burpiOpusEntry.findMany({
    where: { userId, deleted: false, dayKey: { gte: since } },
    select: { dataJson: true, dayKey: true },
  });
  let week = 0;
  let todayReps = 0;
  let doneToday = false;
  for (const row of rows) {
    const data = parseJson(row.dataJson) as { doneTotal?: unknown; done?: unknown; goalReached?: unknown } | null;
    if (!data) continue;
    const reps = typeof data.doneTotal === "number"
      ? data.doneTotal
      : Array.isArray(data.done) ? data.done.reduce((s: number, n: unknown) => s + (typeof n === "number" ? n : 0), 0) : 0;
    week += reps;
    if (row.dayKey === today) {
      todayReps += reps;
      if (data.goalReached === true) doneToday = true;
    }
  }
  return { week, today: todayReps, doneToday };
}

// GET /api/burpi-opus/friends — мой код и недельный рейтинг (я + друзья).
burpiOpusRouter.get("/friends", callerAuth, async (req: BurpiRequest, res: Response) => {
  const userId = req.caller!.userId;
  const code = await friendCodeFor(userId);
  const links = await prisma.burpiFriend.findMany({ where: { userId }, select: { friendId: true } });
  const ids = [userId, ...links.map((l) => l.friendId)];
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true } });
  const names = new Map(users.map((u) => [u.id, u.firstName]));
  const board = await Promise.all(ids.map(async (id) => ({
    id,
    name: names.get(id) || "Друг",
    me: id === userId,
    ...(await weekSummary(id)),
  })));
  board.sort((a, b) => b.week - a.week);
  res.json({ code, board });
});

// POST /api/burpi-opus/friends — { code } добавить друга (взаимно).
burpiOpusRouter.post("/friends", callerAuth, async (req: BurpiRequest, res: Response) => {
  const userId = req.caller!.userId;
  const ip = clientIp(req);
  if (isThrottled(ip)) return res.status(429).json({ error: "too many attempts" });
  const code = String(req.body?.code || "").trim().toUpperCase();
  const row = /^[A-Z0-9]{6}$/.test(code) ? await prisma.burpiFriendCode.findUnique({ where: { code } }) : null;
  if (!row) {
    noteFailure(ip);
    return res.status(404).json({ error: "code not found" });
  }
  if (row.userId === userId) return res.status(400).json({ error: "own code" });
  await prisma.$transaction([
    prisma.burpiFriend.upsert({
      where: { userId_friendId: { userId, friendId: row.userId } },
      update: {},
      create: { userId, friendId: row.userId },
    }),
    prisma.burpiFriend.upsert({
      where: { userId_friendId: { userId: row.userId, friendId: userId } },
      update: {},
      create: { userId: row.userId, friendId: userId },
    }),
  ]);
  const friend = await prisma.user.findUnique({ where: { id: row.userId }, select: { firstName: true } });
  res.json({ ok: true, name: friend?.firstName ?? "" });
});

// DELETE /api/burpi-opus/friends/:id — убрать друга (с обеих сторон).
burpiOpusRouter.delete("/friends/:id", callerAuth, async (req: BurpiRequest, res: Response) => {
  const userId = req.caller!.userId;
  const friendId = Number(req.params.id);
  if (!Number.isInteger(friendId)) return res.status(400).json({ error: "bad id" });
  await prisma.burpiFriend.deleteMany({
    where: { OR: [{ userId, friendId }, { userId: friendId, friendId: userId }] },
  });
  res.json({ ok: true });
});
