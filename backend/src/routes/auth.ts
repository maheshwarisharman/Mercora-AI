import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";

export const authRouter = Router();

// Apply auth middleware to all auth routes
authRouter.use(requireAuth);

/**
 * GET /api/auth/me
 * Returns authenticated user details and metadata
 */
authRouter.get("/me", (req: AuthenticatedRequest, res) => {
  res.json({
    success: true,
    user: {
      id: req.user?.id,
      email: req.user?.email,
      phone: req.user?.phone,
      user_metadata: req.user?.user_metadata,
      app_metadata: req.user?.app_metadata,
      created_at: req.user?.created_at,
      last_sign_in_at: req.user?.last_sign_in_at,
    },
    message: "Authenticated successfully with Mercora Backend",
  });
});

/**
 * GET /api/auth/verify
 * Lightweight verification route for frontend health checks
 */
authRouter.get("/verify", (req: AuthenticatedRequest, res) => {
  res.json({
    success: true,
    userId: req.user?.id,
    email: req.user?.email,
    verifiedAt: new Date().toISOString(),
  });
});
