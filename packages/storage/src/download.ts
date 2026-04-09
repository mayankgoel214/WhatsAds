import { getStorageClient } from "./client.js";

/**
 * Download a file from Supabase Storage and return its contents as a Buffer.
 *
 * @param bucket  Source bucket name
 * @param path    Storage path within the bucket
 * @returns       File contents as a Node Buffer
 */
export async function downloadFile(bucket: string, path: string): Promise<Buffer> {
  const client = getStorageClient();

  const downloadPromise = client.storage.from(bucket).download(path);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Storage download timed out after 30s`)), 30_000)
  );
  const { data, error } = await Promise.race([downloadPromise, timeoutPromise]);

  if (error) {
    throw new Error(
      `Storage download failed [bucket=${bucket} path=${path}]: ${error.message}`
    );
  }

  if (!data) {
    throw new Error(
      `Storage download returned no data [bucket=${bucket} path=${path}]`
    );
  }

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
