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
    noteFailure(ip);
    return res.status(400).json({ error: "bad code" });
  }

  const row = await prisma.burpiPairCode.findUnique({ where: { code } });
  if (!row || row.expiresAt.getTime() < Date.now()) {
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
