import type { Response } from "express";

export function serverError(res: Response, err: unknown): void {
  console.error("[mercatus] error:", err);
  res.status(500).json({ error: "INTERNAL" });
}
