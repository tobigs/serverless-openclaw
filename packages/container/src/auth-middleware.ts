import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function createAuthMiddleware(
  authToken: string,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === "/health") {
      next();
      return;
    }

    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const token = header.slice(7);
    if (!token || !safeCompare(token, authToken)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    next();
  };
}
