import { Router, type Response } from "express";
import type { AuthenticatedRequest } from "../../../middleware/auth";
import { getServiceSupabase, getOrCreateMerchant } from "../../../shared/db/supabase";
import { runMissionNormalization } from "./run";
import type { NormalizedEvent } from "../shared/types";

export const normalizeRouter = Router();

/**
 * POST /api/finance/missions/:missionId/normalize
 * Runs normalization across all unnormalized extracted records for a mission
 */
normalizeRouter.post(
  "/missions/:missionId/normalize",
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const missionId = String(req.params.missionId);
      const authUserId = req.user?.id;
      if (!authUserId) {
        res.status(401).json({ success: false, error: "Unauthorized" });
        return;
      }

      const merchant = await getOrCreateMerchant(authUserId, req.user?.user_metadata);
      const supabase = getServiceSupabase();

      // Verify mission
      const { data: mission, error: missionError } = await supabase
        .schema("finance")
        .from("finance_missions")
        .select("*")
        .eq("id", missionId)
        .eq("merchant_id", merchant.id)
        .maybeSingle();

      if (missionError || !mission) {
        res.status(404).json({
          success: false,
          error: "Not Found",
          message: "Mission not found",
        });
        return;
      }

      const summary = await runMissionNormalization({
        missionId,
        merchantId: merchant.id,
        actorUserId: authUserId,
      });

      res.json({
        success: true,
        data: summary,
      });
    } catch (err: any) {
      console.error("Mission normalization exception:", err);
      res.status(500).json({
        success: false,
        error: "Internal Server Error",
        message: err.message,
      });
    }
  }
);

/**
 * GET /api/finance/missions/:missionId/events
 * Lists normalized events for a mission with optional event_type and source_system filters
 */
normalizeRouter.get(
  "/missions/:missionId/events",
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const missionId = String(req.params.missionId);
      const authUserId = req.user?.id;
      if (!authUserId) {
        res.status(401).json({ success: false, error: "Unauthorized" });
        return;
      }

      const merchant = await getOrCreateMerchant(authUserId, req.user?.user_metadata);
      const supabase = getServiceSupabase();

      const { event_type, source_system } = req.query;

      let query = supabase
        .schema("finance")
        .from("normalized_events")
        .select("*")
        .eq("mission_id", missionId)
        .eq("merchant_id", merchant.id);

      if (event_type && typeof event_type === "string") {
        query = query.eq("event_type", event_type);
      }

      if (source_system && typeof source_system === "string") {
        query = query.eq("source_system", source_system);
      }

      const { data: events, error } = await query
        .order("event_date", { ascending: false })
        .order("created_at", { ascending: false });

      if (error) {
        throw new Error(`Failed to fetch normalized events: ${error.message}`);
      }

      const mappedEvents: NormalizedEvent[] = (events || []).map((evt: any) => ({
        ...evt,
        event_type: evt.metadata?.canonical_event_type || evt.event_type,
        source_system: evt.metadata?.canonical_source_system || evt.source_system,
        batch_ref: evt.metadata?.batch_ref || evt.batch_ref || null,
        order_ids: evt.metadata?.order_ids || evt.order_ids || null,
        deduction_type: evt.metadata?.deduction_type || evt.deduction_type || null,
      }));

      res.json({
        success: true,
        count: mappedEvents.length,
        data: mappedEvents,
      });
    } catch (err: any) {
      console.error("Get normalized events exception:", err);
      res.status(500).json({
        success: false,
        error: "Internal Server Error",
        message: err.message,
      });
    }
  }
);
