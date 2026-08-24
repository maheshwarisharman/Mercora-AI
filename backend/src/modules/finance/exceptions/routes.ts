import { Router, type Request, type Response } from "express";
import { getServiceSupabase } from "../../../shared/db/supabase";
import { runExceptionInvestigation } from "../investigate/run";
import { runExceptionJudgment } from "../judge/classify";

export const exceptionsRouter = Router();

/**
 * GET /api/finance/missions/:id/exceptions
 * Retrieves all detected exceptions for a mission with linked event IDs.
 */
exceptionsRouter.get("/missions/:id/exceptions", async (req: Request, res: Response): Promise<void> => {
  try {
    const missionId = String(req.params.id);
    const merchantId = (req as any).merchant?.id;

    if (!merchantId) {
      res.status(401).json({ success: false, error: "Unauthorized merchant context" });
      return;
    }

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
});

/**
 * POST /api/finance/exceptions/:exceptionId/explain
 * The Killer Interaction: Chains retrieval -> investigate LLM -> judge LLM
 * to explain an exception on-demand and attach supporting evidence.
 */
exceptionsRouter.post("/exceptions/:exceptionId/explain", async (req: Request, res: Response): Promise<void> => {
  try {
    const exceptionId = String(req.params.exceptionId);
    const merchantId = (req as any).merchant?.id;

    if (!merchantId) {
      res.status(401).json({ success: false, error: "Unauthorized merchant context" });
      return;
    }

    const supabase = getServiceSupabase();

    // 1. Run Investigate Stage (Retrieval + Evidence Selection + DB Insert)
    const investigateResult = await runExceptionInvestigation({
      exceptionId,
      merchantId,
    });

    // 2. Run Judge Stage (Classification + Judgment Insert)
    const judgeResult = await runExceptionJudgment({
      exceptionId,
      merchantId,
    });

    // 3. Fetch Fresh Exception Row with Attached Evidence and Judgment
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
      throw new Error(`Failed to load updated exception details: ${fetchErr.message}`);
    }

    res.status(200).json({
      success: true,
      message: "Exception investigation and judgment completed successfully",
      data: {
        exception: updatedException,
        investigation: investigateResult,
        judgment: judgeResult,
        evidence: (updatedException as any).evidence || [],
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
});
