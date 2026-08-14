import { NextFunction, Request, Response } from "express";
import { verifyToken, JwtPayload } from "../utils/jwt";

export interface AuthedRequest extends Request {
  auth?: JwtPayload;
}

export function authMiddleware(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing token" });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: "invalid token" });
  req.auth = payload;
  next();
}
