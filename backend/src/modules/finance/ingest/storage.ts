import crypto from "crypto";
import { getServiceSupabase } from "../../../shared/db/supabase";

export const FINANCE_DOCUMENTS_BUCKET = "finance-documents";

/**
 * Ensures that the required Supabase Storage bucket exists.
 */
export async function ensureBucketExists(bucketName: string = FINANCE_DOCUMENTS_BUCKET): Promise<void> {
  const supabase = getServiceSupabase();
  const { data: buckets, error } = await supabase.storage.listBuckets();

  if (error) {
    console.warn(`[Storage Warning] Error listing buckets:`, error.message);
    return;
  }

  const exists = buckets?.some((b) => b.name === bucketName);
  if (!exists) {
    const { error: createError } = await supabase.storage.createBucket(bucketName, {
      public: false,
    });
    if (createError) {
      console.warn(`[Storage Warning] Failed to create bucket '${bucketName}':`, createError.message);
    } else {
      console.log(`[Storage] Bucket '${bucketName}' created successfully.`);
    }
  }
}

/**
 * Uploads a source document file buffer to Supabase Storage.
 * Path convention: {merchant_id}/{mission_id}/{uuid}-{original_filename}
 */
export async function uploadSourceFile(params: {
  merchantId: string;
  missionId: string;
  filename: string;
  buffer: Buffer;
  mimeType?: string;
}): Promise<string> {
  await ensureBucketExists(FINANCE_DOCUMENTS_BUCKET);
  const supabase = getServiceSupabase();

  const fileUuid = crypto.randomUUID();
  const sanitizedFilename = params.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `${params.merchantId}/${params.missionId}/${fileUuid}-${sanitizedFilename}`;

  const { error } = await supabase.storage
    .from(FINANCE_DOCUMENTS_BUCKET)
    .upload(storagePath, params.buffer, {
      contentType: params.mimeType || "text/csv",
      upsert: true,
    });

  if (error) {
    throw new Error(`Failed to upload file to Supabase storage: ${error.message}`);
  }

  return storagePath;
}

/**
 * Downloads a source document file buffer from Supabase Storage.
 */
export async function downloadSourceFile(storagePath: string): Promise<Buffer> {
  const supabase = getServiceSupabase();
  const { data, error } = await supabase.storage
    .from(FINANCE_DOCUMENTS_BUCKET)
    .download(storagePath);

  if (error || !data) {
    throw new Error(`Failed to download file '${storagePath}' from Supabase storage: ${error?.message || "Not found"}`);
  }

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
