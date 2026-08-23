import { getServiceSupabase } from "../../../shared/db/supabase";
import type { AuditLogEntry } from "./types";

/**
 * Shared audit logging helper. Every stage in the finance pipeline (and future agents)
 * calls this single function to record mutating actions into `audit.audit_log`.
 */
export async function writeAuditLog(params: {
  merchant_id: string;
  mission_id?: string | null;
  actor_type: "system" | "gemini" | "user";
  actor_id?: string | null;
  action: string;
  entity_type: string;
  entity_id?: string | null;
  before?: Record<string, any> | null;
  after?: Record<string, any> | null;
}): Promise<AuditLogEntry | null> {
  try {
    const supabase = getServiceSupabase();
    const payload = {
      merchant_id: params.merchant_id,
      mission_id: params.mission_id || null,
      actor_type: params.actor_type,
      actor_id: params.actor_id || null,
      action: params.action,
      entity_type: params.entity_type,
      entity_id: params.entity_id || null,
      before: params.before || null,
      after: params.after || null,
    };

    const { data, error } = await supabase
      .schema("audit")
      .from("audit_log")
      .insert(payload)
      .select("*")
      .single();

    if (error) {
      console.error(`[AuditLog Error] Failed to write audit log for ${params.action}:`, error);
      return null;
    }

    return data as AuditLogEntry;
  } catch (err) {
    console.error(`[AuditLog Exception] Unexpected error writing audit log for ${params.action}:`, err);
    return null;
  }
}
