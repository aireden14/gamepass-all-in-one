import { Router, Response } from "express";
import { prisma } from "../utils/prisma";
import { authMiddleware, AuthedRequest } from "../middleware/auth";
import { safeJson } from "../utils/json";

// WAVE FORGE beat storage. Tracks are small JSON blobs (a step-sequencer
// pattern) saved per user so they survive across devices and can be pulled
// out later. The client de-duplicates by name, so saving the same name again
// updates the existing track rather than piling up copies.
export const beatsRouter = Router();

const MAX_TRACKS = 60;
const MAX_JSON = 20_000; // a 16-step track is ~1-2 KB; generous ceiling

function clampStr(v: unknown, fallback: string, max = 60): string {
  if (typeof v !== "string") return fallback;
  const s = v.trim();
  return s ? s.slice(0, max) : fallback;
}

// GET /api/beats — list current user's tracks (newest first)
beatsRouter.get("/", authMiddleware, async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const rows = await prisma.beatTrack.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: MAX_TRACKS,
  });
  const tracks = rows.map((r) => {
    let data: any = null;
    try { data = JSON.parse(r.dataJson); } catch { data = null; }
    return {
      id: String(r.id),
      name: r.name,
      bpm: r.bpm,
      scale: r.scale,
      data,
      updatedAt: r.updatedAt.getTime(),
    };
  });
  res.json(safeJson({ tracks }));
});

// POST /api/beats — create or update (upsert by name for this user)
beatsRouter.post("/", authMiddleware, async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const body = req.body || {};
  const data = body.data;
  if (!data || typeof data !== "object") {
    return res.status(400).json({ error: "missing track data" });
  }
  const dataJson = JSON.stringify(data);
  if (dataJson.length > MAX_JSON) {
    return res.status(400).json({ error: "track too large" });
  }
  const name = clampStr(body.name ?? data.name, "Без названия");
  const bpm = Number.isFinite(data.bpm) ? Math.max(40, Math.min(220, Math.round(data.bpm))) : 92;
  const scale = clampStr(data.scale, "minorPentatonic", 40);

  const existing = await prisma.beatTrack.findFirst({ where: { userId, name } });
  let row;
  if (existing) {
    row = await prisma.beatTrack.update({
      where: { id: existing.id },
      data: { dataJson, bpm, scale },
    });
  } else {
    // enforce a soft cap: drop the oldest if over the limit
    const count = await prisma.beatTrack.count({ where: { userId } });
    if (count >= MAX_TRACKS) {
      const oldest = await prisma.beatTrack.findFirst({ where: { userId }, orderBy: { updatedAt: "asc" } });
      if (oldest) await prisma.beatTrack.delete({ where: { id: oldest.id } });
    }
    row = await prisma.beatTrack.create({ data: { userId, name, bpm, scale, dataJson } });
  }
  res.json(safeJson({ id: String(row.id), name: row.name }));
});

// DELETE /api/beats/:id — remove one of the user's tracks
beatsRouter.delete("/:id", authMiddleware, async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
  const row = await prisma.beatTrack.findUnique({ where: { id } });
  if (!row || row.userId !== userId) return res.status(404).json({ error: "not found" });
  await prisma.beatTrack.delete({ where: { id } });
  res.json({ ok: true });
});
