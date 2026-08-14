import jwt from "jsonwebtoken";

export interface JwtPayload {
  userId: number;
  telegramId: string; // BigInt as string
}

export function signToken(payload: JwtPayload): string {
  const secret = process.env.JWT_SECRET || "dev_secret_dev_secret_dev_secret_xx";
  return jwt.sign(payload, secret, { expiresIn: "30d" });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const secret = process.env.JWT_SECRET || "dev_secret_dev_secret_dev_secret_xx";
    return jwt.verify(token, secret) as JwtPayload;
  } catch {
    return null;
  }
}
