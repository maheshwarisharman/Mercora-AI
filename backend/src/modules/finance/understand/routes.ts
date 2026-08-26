import { Router, type Response } from "express";
import Papa from "papaparse";
import { z } from "zod";
import type { AuthenticatedRequest } from "../../../middleware/auth";
import { getServiceSupabase, getOrCreateMerchant } from "../../../shared/db/supabase";
import { writeAuditLog } from "../shared/audit";
import { downloadSourceFile } from "../ingest/storage";
import { classifyDocumentHeuristic } from "./classify";
import type { SourceDocument } from "../shared/types";

export const understandRouter = Router();

const OverrideSourceSchema = z.object({
  detected_source: z.enum([
    "shopify_orders",
    "razorpay_settlement",
    "bank_statement",
    "generic_cod",
    "courier_settlement",
    "vendor_invoice",
    "support_export",
    "unknown",
  ]),
});

/**
 * POST /api/finance/missions/:missionId/documents/:documentId/classify
 * Analyzes filename and CSV header to classify the source document
 */
understandRouter.post(
  "/missions/:missionId/documents/:documentId/classify",
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const missionId = String(req.params.missionId);
      const documentId = String(req.params.documentId);
      const authUserId = req.user?.id;
      if (!authUserId) {
        res.status(401).json({ success: false, error: "Unauthorized" });
        return;
      }

      const merchant = await getOrCreateMerchant(authUserId, req.user?.user_metadata);
      const supabase = getServiceSupabase();

      // 1. Fetch document record
      const { data: doc, error: docError } = await supabase
        .schema("finance")
        .from("source_documents")
        .select("*")
        .eq("id", documentId)
        .eq("mission_id", missionId)
        .eq("merchant_id", merchant.id)
        .maybeSingle();

      if (docError || !doc) {
        res.status(404).json({
          success: false,
          error: "Not Found",
          message: "Document not found for this mission",
        });
        return;
      }

      // 2. Download file content from storage to extract headers
      let headers: string[] = [];
      try {
        const fileBuffer = await downloadSourceFile(doc.file_path);
        const textContent = fileBuffer.toString("utf-8");
        const parsed = Papa.parse(textContent, {
          preview: 2, // parse only header and first row
          header: false,
          skipEmptyLines: true,
        });

        if (parsed.data && parsed.data.length > 0 && Array.isArray(parsed.data[0])) {
          headers = (parsed.data[0] as string[]).map((col) => String(col).trim());
        }
      } catch (storageErr) {
        console.warn(`[Classify Warning] Could not inspect file headers for ${doc.file_path}:`, storageErr);
      }

      // 3. Run heuristic classification
      const result = classifyDocumentHeuristic(doc.original_filename, headers);

      // 4. Update source_documents in Supabase
      const { data: updatedDoc, error: updateError } = await supabase
        .schema("finance")
        .from("source_documents")
        .update({
          detected_source: result.detected_source,
          detection_method: result.detection_method,
          detection_confidence: result.detection_confidence,
        })
        .eq("id", documentId)
        .select("*")
        .single();

      if (updateError || !updatedDoc) {
        throw new Error(`Failed to update document classification: ${updateError?.message}`);
      }

      // 5. Write Audit Log
      await writeAuditLog({
        merchant_id: merchant.id,
        mission_id: missionId,
        actor_type: "user",
        actor_id: authUserId,
        action: "document.classified",
        entity_type: "finance.source_documents",
        entity_id: documentId,
        before: doc,
        after: updatedDoc,
      });

      res.json({
        success: true,
        data: updatedDoc as SourceDocument,
        notes: result.notes,
        is_suspicious: result.is_suspicious,
      });
    } catch (err: any) {
      console.error("Document classification exception:", err);
      res.status(500).json({
        success: false,
        error: "Internal Server Error",
        message: err.message,
      });
    }
  }
);

/**
 * PATCH /api/finance/missions/:missionId/documents/:documentId
 * Manual user override of detected_source
 */
understandRouter.patch(
  "/missions/:missionId/documents/:documentId",
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const missionId = String(req.params.missionId);
      const documentId = String(req.params.documentId);
      const authUserId = req.user?.id;
      if (!authUserId) {
        res.status(401).json({ success: false, error: "Unauthorized" });
        return;
      }

      const parseResult = OverrideSourceSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          error: "Validation Error",
          details: parseResult.error.issues,
        });
        return;
      }

      const { detected_source } = parseResult.data;
      const merchant = await getOrCreateMerchant(authUserId, req.user?.user_metadata);
      const supabase = getServiceSupabase();

      // Fetch current state for audit before
      const { data: currentDoc, error: fetchError } = await supabase
        .schema("finance")
        .from("source_documents")
        .select("*")
        .eq("id", documentId)
        .eq("mission_id", missionId)
        .eq("merchant_id", merchant.id)
        .maybeSingle();

      if (fetchError || !currentDoc) {
        res.status(404).json({
          success: false,
          error: "Not Found",
          message: "Document not found",
        });
        return;
      }

      // Update with user correction
      const { data: updatedDoc, error: updateError } = await supabase
        .schema("finance")
        .from("source_documents")
        .update({
          detected_source,
          detection_method: "user_corrected",
          detection_confidence: 100,
        })
        .eq("id", documentId)
        .select("*")
        .single();

      if (updateError || !updatedDoc) {
        throw new Error(`Failed to update document: ${updateError?.message}`);
      }

      // Write Audit Log
      await writeAuditLog({
        merchant_id: merchant.id,
        mission_id: missionId,
        actor_type: "user",
        actor_id: authUserId,
        action: "document.override",
        entity_type: "finance.source_documents",
        entity_id: documentId,
        before: currentDoc,
        after: updatedDoc,
      });

      res.json({
        success: true,
        data: updatedDoc as SourceDocument,
      });
    } catch (err: any) {
      console.error("Document override exception:", err);
      res.status(500).json({
        success: false,
        error: "Internal Server Error",
        message: err.message,
      });
    }
  }
);
