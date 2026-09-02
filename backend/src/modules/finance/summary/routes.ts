import { Router, type Response } from "express";
import type { AuthenticatedRequest } from "../../../middleware/auth";
import { getOrCreateMerchant, getServiceSupabase } from "../../../shared/db/supabase";
import { writeAuditLog } from "../shared/audit";
import { buildMissionAggregate } from "./aggregate";
import { generateMissionNarrative, PROMPT_VERSION } from "./narrate";

export const summaryRouter = Router();

async function getOwnedMission(req: AuthenticatedRequest, missionId: string) {
  const authUserId = req.user?.id;
  if (!authUserId) throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });

  const merchant = await getOrCreateMerchant(authUserId, req.user?.user_metadata);
  const supabase = getServiceSupabase();
  const { data: mission, error } = await supabase
    .schema("finance")
    .from("finance_missions")
    .select("id, merchant_id, period_start, period_end, objective, status")
    .eq("id", missionId)
    .eq("merchant_id", merchant.id)
    .maybeSingle();

  if (error || !mission) throw Object.assign(new Error("Mission not found"), { statusCode: 404 });
  return { merchant, mission };
}

function sendError(res: Response, error: any) {
  const status = Number(error?.statusCode) || 500;
  res.status(status).json({
    success: false,
    error: status === 409 ? "Mission Incomplete" : status === 404 ? "Not Found" : "Summary failed",
    message: error?.message || "Unable to build mission summary",
  });
}

async function buildAndCache(missionId: string, merchantId: string, promptVersion = PROMPT_VERSION) {
  const supabase = getServiceSupabase();
  const aggregate = await buildMissionAggregate(missionId);
  const narrative = await generateMissionNarrative(aggregate);
  const providerModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const generatedAt = new Date().toISOString();

  const { data: cached, error } = await supabase
    .schema("finance")
    .from("mission_summaries")
    .upsert({
      mission_id: missionId,
      generated_at: generatedAt,
      aggregate_json: aggregate,
      narrative_json: narrative,
      model: providerModel,
      prompt_version: promptVersion,
    }, { onConflict: "mission_id" })
    .select("mission_id, generated_at, aggregate_json, narrative_json, model, prompt_version")
    .single();

  if (error || !cached) throw new Error(`Failed to cache mission summary: ${error?.message || "empty cache row"}`);

  await writeAuditLog({
    merchant_id: merchantId,
    mission_id: missionId,
    actor_type: "gemini",
    actor_id: providerModel,
    action: "mission.summary_generated",
    entity_type: "finance.mission_summaries",
    entity_id: missionId,
    after: {
      input_aggregate: aggregate,
      output_narrative: narrative,
      model: providerModel,
      generated_at: generatedAt,
      prompt_version: promptVersion,
      tool_free: true,
    },
  });

  return cached;
}

/** GET /api/finance/missions/:missionId/summary */
summaryRouter.get("/missions/:missionId/summary", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const missionId = String(req.params.missionId);
    const { merchant, mission } = await getOwnedMission(req, missionId);

    // The current pipeline uses needs_review as its terminal reconciliation
    // state; closed and a future completed state are also reportable.
    if (!["completed", "needs_review", "closed"].includes(String(mission.status))) {
      res.status(409).json({
        success: false,
        error: "Mission Incomplete",
        message: "Summary is available after reconciliation completes.",
        pipelineStage: mission.status,
        status: mission.status,
      });
      return;
    }

    const supabase = getServiceSupabase();
    const { data: cached, error } = await supabase
      .schema("finance")
      .from("mission_summaries")
      .select("mission_id, generated_at, aggregate_json, narrative_json, model, prompt_version")
      .eq("mission_id", missionId)
      .maybeSingle();

    if (error) throw new Error(`Failed to load cached mission summary: ${error.message}`);
    if (cached) {
      // Recompute the deterministic SQL aggregate so live updates to exceptions (e.g. resolved items),
      // matches, or events are always immediately reflected in the report metrics and Priority Queue
      // table without needing an expensive narrative LLM regeneration.
      const freshAggregate = await buildMissionAggregate(missionId);
      if (JSON.stringify(cached.aggregate_json) !== JSON.stringify(freshAggregate)) {
        await supabase
          .schema("finance")
          .from("mission_summaries")
          .update({ aggregate_json: freshAggregate })
          .eq("mission_id", missionId);
        cached.aggregate_json = freshAggregate;
      }
      res.json({ success: true, data: cached });
      return;
    }

    const summary = await buildAndCache(missionId, merchant.id);
    res.json({ success: true, data: summary });
  } catch (error: any) {
    sendError(res, error);
  }
});

/** POST /api/finance/missions/:missionId/summary/regenerate */
summaryRouter.post("/missions/:missionId/summary/regenerate", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const missionId = String(req.params.missionId);
    const { merchant, mission } = await getOwnedMission(req, missionId);
    if (!["completed", "needs_review", "closed"].includes(String(mission.status))) {
      res.status(409).json({ success: false, error: "Mission Incomplete", pipelineStage: mission.status });
      return;
    }
    const supabase = getServiceSupabase();
    const { data: previous } = await supabase
      .schema("finance")
      .from("mission_summaries")
      .select("prompt_version")
      .eq("mission_id", missionId)
      .maybeSingle();
    const previousVersion = String(previous?.prompt_version || PROMPT_VERSION);
    const versionParts = previousVersion.split(".").map((part) => Number(part));
    const promptVersion = versionParts.length === 3 && versionParts.every(Number.isFinite)
      ? `${versionParts[0]}.${versionParts[1]}.${versionParts[2] + 1}`
      : PROMPT_VERSION;
    const summary = await buildAndCache(missionId, merchant.id, promptVersion);
    res.json({ success: true, data: summary });
  } catch (error: any) {
    sendError(res, error);
  }
});
