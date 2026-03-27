import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import * as fs from "node:fs";
import * as path from "node:path";

interface S3SyncParams {
  bucket: string;
  prefix: string;
  localPath: string;
  region?: string;
  /** Directory names to exclude from backup (e.g., ["agents"] to skip sessions) */
  excludeDirs?: string[];
}

export async function restoreFromS3(params: S3SyncParams): Promise<void> {
  const client = new S3Client({ region: params.region });
  const { bucket, prefix, localPath } = params;

  try {
    let continuationToken: string | undefined;
    do {
      const listResp = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix.endsWith("/") ? prefix : `${prefix}/`,
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of listResp.Contents ?? []) {
        if (!obj.Key || obj.Key.endsWith("/")) continue;

        const relativePath = obj.Key.slice(prefix.length).replace(/^\//, "");
        if (!relativePath) continue;

        const localFilePath = path.join(localPath, relativePath);
        fs.mkdirSync(path.dirname(localFilePath), { recursive: true });

        const getResp = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: obj.Key }),
        );

        if (getResp.Body) {
          const bytes = await getResp.Body.transformToByteArray();
          fs.writeFileSync(localFilePath, bytes);
        }
      }

      continuationToken = listResp.IsTruncated
        ? listResp.NextContinuationToken
        : undefined;
    } while (continuationToken);
  } catch {
    // Restore failure is non-fatal (first launch has no data)
    console.log("[s3-sync] No workspace data to restore (or S3 error)");
  }
}

export async function backupToS3(params: S3SyncParams): Promise<void> {
  const client = new S3Client({ region: params.region });
  const { bucket, prefix, localPath } = params;

  if (!fs.existsSync(localPath)) return;

  async function uploadDir(dirPath: string, s3Prefix: string): Promise<void> {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (params.excludeDirs?.includes(entry.name)) continue;
        await uploadDir(fullPath, `${s3Prefix}/${entry.name}`);
      } else if (entry.isFile()) {
        const body = fs.readFileSync(fullPath);
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: `${s3Prefix}/${entry.name}`,
            Body: body,
          }),
        );
      }
    }
  }

  await uploadDir(localPath, prefix);
}
