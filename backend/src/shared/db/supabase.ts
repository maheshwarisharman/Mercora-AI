import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import type { CoreMerchant } from "../../modules/finance/shared/types";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || "https://your-project.supabase.co";
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("⚠️ Warning: SUPABASE_SERVICE_ROLE_KEY not defined. Falling back to default.");
}

// Singleton Service Role Client for backend processes
export const supabaseAdmin: SupabaseClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

export const getServiceSupabase = (): SupabaseClient => {
  return supabaseAdmin;
};

/**
 * Ensures a merchant record exists in `core.merchants` for the given auth user ID.
 * Returns the CoreMerchant entity.
 */
export async function getOrCreateMerchant(
  authUserId: string,
  metadata?: { store_name?: string; business_name?: string; default_currency?: string }
): Promise<CoreMerchant> {
  const admin = getServiceSupabase();

  // 1. Try to find existing merchant by auth_user_id
  const { data: existing, error: findError } = await admin
    .schema("core")
    .from("merchants")
    .select("*")
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  if (findError) {
    console.error("Error finding merchant for auth_user_id:", authUserId, findError);
    throw new Error(`Failed to query merchant: ${findError.message}`);
  }

  if (existing) {
    return existing as CoreMerchant;
  }

  // 2. Create a new merchant if not found
  const businessName = metadata?.business_name || metadata?.store_name || "Mercora Merchant";
  const defaultCurrency = metadata?.default_currency || "INR";

  const { data: created, error: insertError } = await admin
    .schema("core")
    .from("merchants")
    .insert({
      auth_user_id: authUserId,
      business_name: businessName,
      default_currency: defaultCurrency,
    })
    .select("*")
    .single();

  if (insertError) {
    console.error("Error creating merchant for auth_user_id:", authUserId, insertError);
    throw new Error(`Failed to create merchant: ${insertError.message}`);
  }

  return created as CoreMerchant;
}
