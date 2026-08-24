import { Router, type Response } from "express";
import type { AuthenticatedRequest } from "../../../middleware/auth";
import { getServiceSupabase, getOrCreateMerchant } from "../../../shared/db/supabase";
import { runMissionReconciliation } from "./run";

export const reconcileRouter = Router();

/**
 * POST /api/finance/missions/:id/reconcile
 * Executes deterministic reconciliation + exception detection across all normalized events.
 */
reconcileRouter.post(
  "/missions/:id/reconcile",
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const missionId = String(req.params.id);
      const authUserId = req.user?.id;

      if (!authUserId) {
        res.status(401).json({ success: false, error: "Unauthorized" });
        return;
      }

      const merchant = await getOrCreateMerchant(authUserId, req.user?.user_metadata);

      const summary = await runMissionReconciliation({
        missionId,
        merchantId: merchant.id,
        actorUserId: authUserId,
      });

      res.status(200).json({
        success: true,
        message: "Mission reconciliation and exception detection completed successfully",
        data: summary,
      });
    } catch (error: any) {
      console.error("Error during mission reconciliation:", error);
      res.status(500).json({
        success: false,
        error: "Reconciliation failed",
        message: error.message,
      });
    }
  }
);

/**
 * GET /api/finance/missions/:id/matches
 * Retrieves all reconciled match chains for a mission.
 */
reconcileRouter.get(
  "/missions/:id/matches",
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const missionId = String(req.params.id);
      const authUserId = req.user?.id;

      if (!authUserId) {
        res.status(401).json({ success: false, error: "Unauthorized" });
        return;
      }

      const merchant = await getOrCreateMerchant(authUserId, req.user?.user_metadata);
      const supabase = getServiceSupabase();

      const { data: matches, error } = await supabase
        .schema("finance")
        .from("matches")
        .select("*")
        .eq("mission_id", missionId)
        .order("created_at", { ascending: true });

      if (error) {
        res.status(500).json({ success: false, error: error.message });
        return;
      }

      res.status(200).json({
        success: true,
        count: matches?.length || 0,
        data: matches || [],
      });
    } catch (error: any) {
      console.error("Error fetching matches:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  }
);
