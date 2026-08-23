import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { healthRouter } from "./routes/health";
import { authRouter } from "./routes/auth";
import { financeRouter } from "./api/finance.routes";

dotenv.config();

const app = express();
const port = process.env.PORT || 5001;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
// Apply JSON and URL-encoded parsing conditionally to bypass multipart/form-data, GET/HEAD/OPTIONS, and empty requests
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }
  if (req.headers["content-type"]?.startsWith("multipart/form-data")) {
    return next();
  }
  const contentLength = req.headers["content-length"];
  if (contentLength === "0") {
    req.body = {};
    return next();
  }
  express.json()(req, res, next);
});

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }
  if (req.headers["content-type"]?.startsWith("multipart/form-data")) {
    return next();
  }
  const contentLength = req.headers["content-length"];
  if (contentLength === "0") {
    req.body = {};
    return next();
  }
  express.urlencoded({ extended: true })(req, res, next);
});

// Gracefully handle body-parser JSON parsing syntax errors (400 Bad Request instead of 500 Unhandled)
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof SyntaxError && "status" in err && err.status === 400 && "body" in err) {
    res.status(400).json({
      success: false,
      error: "Bad Request",
      message: "Malformed JSON payload",
    });
    return;
  }
  next(err);
});

// Request logging (clean and minimal)
app.use((req: Request, _res: Response, next: NextFunction) => {
  const start = Date.now();
  _res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${_res.statusCode} (${duration}ms)`);
  });
  next();
});

// Routes
app.use("/api/health", healthRouter);
app.use("/api/auth", authRouter);
app.use("/api/finance", financeRouter);

// 404 Fallback
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: "Not Found",
    message: "Endpoint not found",
  });
});

// Global Error Handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled server error:", err);
  res.status(500).json({
    success: false,
    error: "Internal Server Error",
    message: process.env.NODE_ENV === "production" ? "Something went wrong" : err.message,
  });
});

// Start Server
app.listen(port, () => {
  console.log(`🚀 Mercora Backend running on http://localhost:${port}`);
  console.log(`📡 Health check available at http://localhost:${port}/api/health`);
  console.log(`🔒 Protected auth routes mounted at http://localhost:${port}/api/auth`);
});
