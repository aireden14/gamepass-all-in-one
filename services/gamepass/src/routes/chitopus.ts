import { Router, Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { prisma } from "../utils/prisma";
import { verifyToken } from "../utils/jwt";

// Читопус: общий дневник чтения для GamePass и веб-версии в браузере
// (aireden14.github.io/chitopus).
//
// GamePass приходит с обычным JWT, браузер — с токеном `Authorization: Reader
// <token>`, который выдаётся один раз по 6-значному коду из настроек Читопуса в
// GamePass. Записи — книги и сессии чтения как есть (JSON), ключ — клиентский
// id с префиксом (`b-` книга, `s-` сессия). Удаление ставит `deleted`, чтобы
// другое устройство не вернуло удалённое при следующей отправке.
export const chitopusRouter = Router();

type Caller = { userId: number; via: "gamepass" | "web" };
interface ChitopusRequest extends Request {
  caller?: Caller;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ENTRY_JSON = 40_000;
const MAX_CONFIG_JSON = 20_000;
const MAX_ENTRIES_PER_SYNC = 500;
const PAGE = 1000;
const CURSOR_OVERLAP_MS = 5_000;
const PAIR_TTL_MS = 10 * 60 * 1000;

type Handler = (req: ChitopusRequest, res: Response, next: NextFunction) => Promise<unknown>;
const wrap = (fn: Handler) => (req: ChitopusRequest, res: Response, next: NextFunction) => {
  fn(req, res, next).catch(next);
};

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const callerAuth = wrap(async (req, res, next) => {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) {
    const payload = verifyToken(header.slice(7));
    if (!payload) return res.status(401).json({ error: "invalid token" });
    req.caller = { userId: payload.userId, via: "gamepass" };
    return next();
  }
  if (header.startsWith("Reader ")) {
    const token = header.slice(7).trim();
    const link = token
      ? await prisma.chitopusDeviceLink.findUnique({ where: { tokenHash: hashToken(token) } })
      : null;
    if (!link) return res.status(401).json({ error: "device not linked" });
    void prisma.chitopusDeviceLink
      .update({ where: { id: link.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
    req.caller = { userId: link.userId, via: "web" };
    return next();
  }
  return res.status(401).json({ error: "missing token" });
});

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ состояние */

// GET /api/chitopus/state?since=<ms> — записи, изменённые после курсора, и
// общие настройки (норма, пояс, активная книга).
chitopusRouter.get("/state", callerAuth, wrap(async (req, res) => {
  const userId = req.caller!.userId;
  const sinceRaw = Number(req.query.since);
  const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;

  const rows = await prisma.chitopusEntry.findMany({
    where: { userId, updatedAt: { gte: new Date(since) } },
    orderBy: { updatedAt: "asc" },
    take: PAGE,
  });
  const more = rows.length === PAGE;
  const last = rows.length ? rows[rows.length - 1].updatedAt.getTime() : since;
  const cursor = more ? last : Math.max(0, last - CURSOR_OVERLAP_MS);

  const [profile, user] = await Promise.all([
    prisma.chitopusProfile.findUnique({ where: { userId } }),
    prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, username: true } }),
  ]);

  res.json({
    entries: rows.map((r) => ({
      id: r.clientId,
      deleted: r.deleted,
      updatedAt: r.updatedAt.getTime(),
      data: r.deleted ? null : parseJson(r.dataJson),
    })),
    cursor,
    more,
    config: profile ? parseJson(profile.configJson) : null,
    account: { name: user?.firstName ?? "", username: user?.username ?? "" },
    serverTime: Date.now(),
  });
}));

// POST /api/chitopus/sync — { entries: [{id, data?, deleted?}], config? }.
chitopusRouter.post("/sync", callerAuth, wrap(async (req, res) => {
  const { userId, via } = req.caller!;
  const body = req.body || {};
  const incoming: unknown[] = Array.isArray(body.entries) ? body.entries : [];
  if (incoming.length > MAX_ENTRIES_PER_SYNC) {
    return res.status(400).json({ error: "too many entries" });
  }

  let accepted = 0;
  for (const raw of incoming) {
    const item = raw as { id?: unknown; data?: unknown; deleted?: unknown };
    if (typeof item?.id !== "string" || !ID_RE.test(item.id)) continue;
    const clientId = item.id;
    const where = { userId_clientId: { userId, clientId } };

    if (item.deleted === true) {
      await prisma.chitopusEntry.upsert({
        where,
        update: { deleted: true },
        create: { userId, clientId, dataJson: "{}", deleted: true, source: via },
      });
      accepted += 1;
      continue;
    }

    if (!item.data || typeof item.data !== "object" || Array.isArray(item.data)) continue;
    const dataJson = JSON.stringify(item.data);
    if (dataJson.length > MAX_ENTRY_JSON) continue;
    await prisma.chitopusEntry.upsert({
      where,
      update: { dataJson, deleted: false, source: via },
      create: { userId, clientId, dataJson, source: via },
    });
    accepted += 1;
  }

  if (body.config && typeof body.config === "object" && !Array.isArray(body.config)) {
    const configJson = JSON.stringify(body.config);
    if (configJson.length <= MAX_CONFIG_JSON) {
      await prisma.chitopusProfile.upsert({
        where: { userId },
        update: { configJson },
        create: { userId, configJson },
      });
    }
  }

  res.json({ ok: true, accepted, serverTime: Date.now() });
}));

/* ------------------------------------------------- вход в браузере по коду */

// POST /api/chitopus/pair-code — одноразовый код, живёт 10 минут. Выдаётся
// только из GamePass: браузер сам себе код не выпишет.
chitopusRouter.post("/pair-code", callerAuth, wrap(async (req, res) => {
  if (req.caller!.via !== "gamepass") return res.status(403).json({ error: "gamepass only" });
  const userId = req.caller!.userId;
  await prisma.chitopusPairCode.deleteMany({
    where: { OR: [{ userId }, { expiresAt: { lt: new Date() } }] },
  });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const taken = await prisma.chitopusPairCode.findUnique({ where: { code } });
    if (taken) continue;
    const expiresAt = new Date(Date.now() + PAIR_TTL_MS);
    await prisma.chitopusPairCode.create({ data: { code, userId, expiresAt } });
    return res.json({ code, expiresAt: expiresAt.getTime() });
  }
  return res.status(503).json({ error: "try again" });
}));

// Код из 6 цифр перебирается, если не ограничивать попытки.
const failures = new Map<string, { count: number; resetAt: number }>();
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_LIMIT_PER_IP = 10;
const FAIL_LIMIT_GLOBAL = 60;
let globalFailures = { count: 0, resetAt: 0 };

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

// POST /api/chitopus/pair — { code, device? } → { token, name }. Без авторизации.
chitopusRouter.post("/pair", wrap(async (req, res) => {
  const ip = clientIp(req);
  if (isThrottled(ip)) return res.status(429).json({ error: "too many attempts" });

  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  const row = /^\d{6}$/.test(code) ? await prisma.chitopusPairCode.findUnique({ where: { code } }) : null;
  if (!row || row.expiresAt.getTime() < Date.now()) {
    noteFailure(ip);
    return res.status(404).json({ error: "code not found" });
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const device = typeof req.body?.device === "string" ? req.body.device.slice(0, 60) : "";
  await prisma.$transaction([
    prisma.chitopusPairCode.delete({ where: { code } }),
    prisma.chitopusDeviceLink.create({ data: { userId: row.userId, tokenHash: hashToken(token), device } }),
  ]);
  const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { firstName: true } });
  return res.json({ token, name: user?.firstName ?? "" });
}));

// POST /api/chitopus/logout — браузер выходит: его токен больше не действует.
chitopusRouter.post("/logout", wrap(async (req, res) => {
  const header = req.headers.authorization || "";
  if (header.startsWith("Reader ")) {
    await prisma.chitopusDeviceLink.deleteMany({ where: { tokenHash: hashToken(header.slice(7).trim()) } });
  }
  res.json({ ok: true });
}));
