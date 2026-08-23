import { Router, type Response } from "express";
import type { AuthenticatedRequest } from "../../../middleware/auth";
import { getServiceSupabase, getOrCreateMerchant } from "../../../shared/db/supabase";
import { writeAuditLog } from "../shared/audit";
import { downloadSourceFile } from "../ingest/storage";
import { parseCsvBufferToRecords } from "./csv";

export const extractRouter = Router();

/**
 * POST /api/finance/missions/:missionId/documents/:documentId/extract
 * Deterministically parses CSV source document into extracted_records
 */
extractRouter.post(
  "/missions/:missionId/documents/:documentId/extract",
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

      // 1. Fetch document and verify existence & source type
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

      if (doc.detected_source === "unknown") {
        res.status(422).json({
          success: false,
          error: "Unprocessable Entity",
          message: "Cannot extract document with 'unknown' detected_source. Please classify or manually assign a source first.",
        });
        return;
      }

      // 2. Download file buffer from storage
      const fileBuffer = await downloadSourceFile(doc.file_path);

      // 3. Parse CSV rows
      const recordsToInsert = parseCsvBufferToRecords({
        buffer: fileBuffer,
        sourceDocumentId: doc.id,
        missionId,
        merchantId: merchant.id,
      });

      if (recordsToInsert.length === 0) {
        res.status(400).json({
          success: false,
          error: "Empty File",
          message: "No valid rows found in the uploaded CSV document",
        });
        return;
      }

      // Clean up any existing extracted_records for this document to ensure idempotency
      await supabase
        .schema("finance")
        .from("extracted_records")
        .delete()
        .eq("source_document_id", documentId);

      // 4. Batch insert into finance.extracted_records
      // Supabase supports bulk inserts with arrays
      const batchSize = 100;
      for (let i = 0; i < recordsToInsert.length; i += batchSize) {
        const chunk = recordsToInsert.slice(i, i + batchSize);
        const { error: insertError } = await supabase
          .schema("finance")
          .from("extracted_records")
          .insert(chunk);

        if (insertError) {
          throw new Error(`Failed to insert extracted records chunk: ${insertError.message}`);
        }
      }

      // 5. Write Audit Log
      await writeAuditLog({
        merchant_id: merchant.id,
        mission_id: missionId,
        actor_type: "user",
        actor_id: authUserId,
        action: "document.extracted",
        entity_type: "finance.extracted_records",
        entity_id: documentId,
        after: {
          records_count: recordsToInsert.length,
          source_document_id: documentId,
        },
      });

      res.json({
        success: true,
        count: recordsToInsert.length,
        sample: recordsToInsert.slice(0, 3).map((r) => r.raw_json),
      });
    } catch (err: any) {
      console.error("Document extraction exception:", err);
      res.status(500).json({
        success: false,
        error: "Internal Server Error",
        message: err.message,
      });
    }
  }
);
