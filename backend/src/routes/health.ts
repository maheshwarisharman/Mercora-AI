import { Router } from "express";

export const healthRouter = Router();

healthRouter.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "mercora-backend",
    version: "1.0.0",
    runtime: "bun",
    timestamp: new Date().toISOString(),
  });
});
