import { Router, type Response } from "express";
import type { AuthenticatedRequest } from "../../../middleware/auth";
import { getServiceSupabase, getOrCreateMerchant } from "../../../shared/db/supabase";
import { runExceptionInvestigation } from "../investigate/run";

export const exceptionsRouter = Router();

/**
 * GET /api/finance/missions/:id/exceptions
 * Retrieves all detected exceptions for a mission with linked evidence and judgments.
 */
exceptionsRouter.get(
  "/missions/:id/exceptions",
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const missionId = String(req.params.id);
      const authUserId = req.user?.id;

      if (!authUserId) {
        res.status(401).json({ success: false, error: "Unauthorized" });
        return;
      }

      await getOrCreateMerchant(authUserId, req.user?.user_metadata);
      const supabase = getServiceSupabase();

      const { data: exceptions, error } = await supabase
        .schema("finance")
        .from("exceptions")
        .select(`
          *,
          evidence (*),
          exception_judgments (*)
        `)
        .eq("mission_id", missionId)
        .order("created_at", { ascending: true });

      if (error) {
        res.status(500).json({ success: false, error: error.message });
        return;
      }

      res.status(200).json({
        success: true,
        count: exceptions?.length || 0,
        data: exceptions || [],
      });
    } catch (error: any) {
      console.error("Error fetching exceptions:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

/**
 * POST /api/finance/exceptions/:exceptionId/explain
 * Runs the agentic investigation loop to explain an exception on-demand.
 * Same external contract as Batch 4; response now includes `trace` and `hitStepBudget`.
 */
exceptionsRouter.post(
  "/exceptions/:exceptionId/explain",
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const exceptionId = String(req.params.exceptionId);
      const authUserId = req.user?.id;

      if (!authUserId) {
        res.status(401).json({ success: false, error: "Unauthorized" });
        return;
      }

      const merchant = await getOrCreateMerchant(authUserId, req.user?.user_metadata);
      const supabase = getServiceSupabase();

      // Run the agentic investigation loop (replaces separate investigate + judge calls)
      const investigateResult = await runExceptionInvestigation({
        exceptionId,
        merchantId: merchant.id,
      });

      // Fetch the updated exception row with attached evidence and judgment
      const { data: updatedException, error: fetchErr } = await supabase
        .schema("finance")
        .from("exceptions")
        .select(`
          *,
          evidence (*),
          exception_judgments (*)
        `)
        .eq("id", exceptionId)
        .single();

      if (fetchErr) {
        throw new Error(`Failed to load updated exception: ${fetchErr.message}`);
      }

      res.status(200).json({
        success: true,
        message: "Exception investigation completed successfully",
        data: {
          exception: updatedException,
          judgment: {
            judgment_id: investigateResult.judgment_id,
            classification: investigateResult.classification,
            confidence: investigateResult.confidence,
            explanation: investigateResult.explanation,
            evidence_ids: investigateResult.evidence_ids,
            recommended_action: investigateResult.recommended_action,
            merchant_category: investigateResult.merchant_category,
            model: investigateResult.model,
          },
          // Agent trace — rendered by the frontend ReasoningTrace component
          trace: investigateResult.trace,
          hitStepBudget: investigateResult.hitStepBudget,
          evidence: (updatedException as any)?.evidence || [],
        },
      });
    } catch (error: any) {
      console.error("Error explaining exception:", error);
      res.status(500).json({
        success: false,
        error: "Failed to explain exception",
        message: error.message,
      });
    }
  }
);
