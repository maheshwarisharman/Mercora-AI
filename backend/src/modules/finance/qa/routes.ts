import { Router, type Response } from "express";
import type { AuthenticatedRequest } from "../../../middleware/auth";
import { getOrCreateMerchant } from "../../../shared/db/supabase";
import { runSettlementQA } from "./run";

export const qaRouter = Router();

/**
 * POST /api/finance/missions/:missionId/ask
 * Settlement Q&A endpoint — stateless server-side; conversation history round-trips via client.
 *
 * Body: { question: string, conversationHistory?: AgentMessage[] }
 * Response: { answer, citedExceptionIds, citedEvidenceIds, trace, hitStepBudget, updatedConversationHistory }
 */
qaRouter.post(
  "/missions/:missionId/ask",
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const missionId = String(req.params.missionId);
      const authUserId = req.user?.id;

      if (!authUserId) {
        res.status(401).json({ success: false, error: "Unauthorized" });
        return;
      }

      const { question, conversationHistory } = req.body as {
        question?: string;
        conversationHistory?: any[];
      };

      if (!question || typeof question !== "string" || question.trim().length === 0) {
        res.status(400).json({
          success: false,
          error: "Bad Request",
          message: "'question' is required and must be a non-empty string.",
        });
        return;
      }

      const merchant = await getOrCreateMerchant(authUserId, req.user?.user_metadata);

      const result = await runSettlementQA({
        missionId,
        merchantId: merchant.id,
        question: question.trim(),
        conversationHistory: Array.isArray(conversationHistory) ? conversationHistory : [],
      });

      res.status(200).json({
        success: true,
        data: {
          answer: result.answer,
          citedExceptionIds: result.citedExceptionIds,
          citedEvidenceIds: result.citedEvidenceIds,
          couldNotAnswer: result.couldNotAnswer,
          trace: result.trace,
          hitStepBudget: result.hitStepBudget,
          updatedConversationHistory: result.updatedConversationHistory,
        },
      });
    } catch (error: any) {
      console.error("[Q&A] Error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to process question",
        message: error.message,
      });
    }
  }
);
