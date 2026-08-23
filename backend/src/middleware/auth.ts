import type { Request, Response, NextFunction } from "express";
import type { User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

export interface AuthenticatedRequest extends Request {
  user?: User;
  token?: string;
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
        message: "Missing or invalid Authorization header. Expected 'Bearer <token>'.",
      });
      return;
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
        message: "Access token is required.",
      });
      return;
    }

    // Verify token with Supabase Auth
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
        message: error?.message || "Invalid or expired token.",
      });
      return;
    }

    // Attach user and token to request
    req.user = user;
    req.token = token;
    next();
  } catch (err: any) {
    console.error("Auth middleware error:", err);
    res.status(500).json({
      success: false,
      error: "Internal Server Error",
      message: "An error occurred during authentication verification.",
    });
  }
}
