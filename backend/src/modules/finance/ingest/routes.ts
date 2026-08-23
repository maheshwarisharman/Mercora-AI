import { Router, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import type { AuthenticatedRequest } from "../../../middleware/auth";
import { getServiceSupabase, getOrCreateMerchant } from "../../../shared/db/supabase";
import { writeAuditLog } from "../shared/audit";
import { uploadSourceFile } from "./storage";
import type { FinanceMission, SourceDocument } from "../shared/types";

export const ingestRouter = Router();

// Multer memory storage configuration for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
});

// Zod Schema for Mission Creation
const CreateMissionSchema = z.object({
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "period_start must be YYYY-MM-DD"),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "period_end must be YYYY-MM-DD"),
  sources: z.array(z.string()).min(1, "At least one source is required"),
  objective: z.string().optional().nullable(),
});

/**
 * POST /api/finance/missions
 * Creates a new finance mission
 */
ingestRouter.post("/missions", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parseResult = CreateMissionSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        success: false,
        error: "Validation Error",
        details: parseResult.error.issues,
      });
      return;
    }

    const { period_start, period_end, sources, objective } = parseResult.data;

    // Validate period_end >= period_start
    if (new Date(period_end) < new Date(period_start)) {
      res.status(400).json({
        success: false,
        error: "Invalid Date Range",
        message: "period_end must be greater than or equal to period_start",
      });
      return;
    }

    const authUserId = req.user?.id;
    if (!authUserId) {
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }

    const merchant = await getOrCreateMerchant(authUserId, req.user?.user_metadata);
    const supabase = getServiceSupabase();

    const { data: mission, error: insertError } = await supabase
      .schema("finance")
      .from("finance_missions")
      .insert({
        merchant_id: merchant.id,
        period_start,
        period_end,
        sources: JSON.stringify(sources),
        objective: objective || null,
        status: "created",
      })
      .select("*")
      .single();

    if (insertError || !mission) {
      console.error("Error creating mission:", insertError);
      res.status(500).json({
        success: false,
        error: "Database Error",
        message: insertError?.message || "Failed to create finance mission",
      });
      return;
    }

    // Write Audit Log
    await writeAuditLog({
      merchant_id: merchant.id,
      mission_id: mission.id,
      actor_type: "user",
      actor_id: authUserId,
      action: "mission.created",
      entity_type: "finance.finance_missions",
      entity_id: mission.id,
      after: mission,
    });

    res.status(201).json({
      success: true,
      data: mission as FinanceMission,
    });
  } catch (err: any) {
    console.error("Mission creation exception:", err);
    res.status(500).json({
      success: false,
      error: "Internal Server Error",
      message: err.message,
    });
  }
});

/**
 * GET /api/finance/missions/:id
 * Fetches mission detail
 */
ingestRouter.get("/missions/:id", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const authUserId = req.user?.id;
    if (!authUserId) {
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }

    const merchant = await getOrCreateMerchant(authUserId, req.user?.user_metadata);
    const supabase = getServiceSupabase();

    const { data: mission, error } = await supabase
      .schema("finance")
      .from("finance_missions")
      .select("*")
      .eq("id", id)
      .eq("merchant_id", merchant.id)
      .maybeSingle();

    if (error || !mission) {
      res.status(404).json({
        success: false,
        error: "Not Found",
        message: "Mission not found",
      });
      return;
    }

    res.json({
      success: true,
      data: mission as FinanceMission,
    });
  } catch (err: any) {
    console.error("Get mission exception:", err);
    res.status(500).json({
      success: false,
      error: "Internal Server Error",
      message: err.message,
    });
  }
});

/**
 * POST /api/finance/missions/:missionId/documents
 * Accepts single or multiple file upload via multipart/form-data
 */
ingestRouter.post(
  "/missions/:missionId/documents",
  upload.any(),
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

      // Verify mission exists and belongs to merchant
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
          message: "Finance mission not found",
        });
        return;
      }

      const files = (req.files as Express.Multer.File[]) || (req.file ? [req.file] : []);
      if (!files || files.length === 0) {
        res.status(400).json({
          success: false,
          error: "Bad Request",
          message: "No files uploaded. Provide file(s) in multipart/form-data under 'file' or 'files'.",
        });
        return;
      }

      const uploadedDocs: SourceDocument[] = [];

      for (const file of files) {
        // Upload to Supabase Storage
        const storagePath = await uploadSourceFile({
          merchantId: merchant.id,
          missionId,
          filename: file.originalname,
          buffer: file.buffer,
          mimeType: file.mimetype,
        });

        // Insert into finance.source_documents
        const { data: doc, error: docError } = await supabase
          .schema("finance")
          .from("source_documents")
          .insert({
            mission_id: missionId,
            merchant_id: merchant.id,
            file_path: storagePath,
            original_filename: file.originalname,
            mime_type: file.mimetype || "text/csv",
            detected_source: "unknown",
            detection_method: "filename_heuristic",
            detection_confidence: 0,
          })
          .select("*")
          .single();

        if (docError || !doc) {
          console.error("Error inserting source_document:", docError);
          throw new Error(`Failed to save source document metadata: ${docError?.message}`);
        }

        // Write Audit Log
        await writeAuditLog({
          merchant_id: merchant.id,
          mission_id: missionId,
          actor_type: "user",
          actor_id: authUserId,
          action: "document.uploaded",
          entity_type: "finance.source_documents",
          entity_id: doc.id,
          after: doc,
        });

        uploadedDocs.push(doc as SourceDocument);
      }

      // Return either single document or array based on input
      res.status(201).json({
        success: true,
        data: uploadedDocs.length === 1 ? uploadedDocs[0] : uploadedDocs,
      });
    } catch (err: any) {
      console.error("Document upload exception:", err);
      res.status(500).json({
        success: false,
        error: "Internal Server Error",
        message: err.message,
      });
    }
  }
);

/**
 * GET /api/finance/missions/:missionId/documents
 * Lists all source documents for a mission
 */
ingestRouter.get(
  "/missions/:missionId/documents",
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

      const { data: documents, error } = await supabase
        .schema("finance")
        .from("source_documents")
        .select("*")
        .eq("mission_id", missionId)
        .eq("merchant_id", merchant.id)
        .order("uploaded_at", { ascending: true });

      if (error) {
        res.status(500).json({
          success: false,
          error: "Database Error",
          message: error.message,
        });
        return;
      }

      res.json({
        success: true,
        data: (documents || []) as SourceDocument[],
      });
    } catch (err: any) {
      console.error("List documents exception:", err);
      res.status(500).json({
        success: false,
        error: "Internal Server Error",
        message: err.message,
      });
    }
  }
);
