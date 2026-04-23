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
}

// Workspace is persistent user-content storage. Runtime-installed tools
// (node_modules, downloaded binaries, git clones) must not be persisted —
// they bloat cold-start restore (3670 files / 164 MiB observed 2026-04-23)
// and belong in the container image or ephemeral scratch instead.
//
// See docs/local/adr-001-three-layer-storage-model.md for the model.
const EXCLUDE_PATH_SEGMENTS = ["node_modules", ".git", "bin", ".cache", "__pycache__", ".venv"];
const EXCLUDE_EXTENSIONS = new Set([".pdf", ".exe", ".dll", ".so", ".dylib", ".bin"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB

export function shouldExclude(relativePath: string, sizeBytes?: number): boolean {
  const segments = relativePath.split("/");
  if (segments.some((s) => EXCLUDE_PATH_SEGMENTS.includes(s))) return true;
  const ext = path.extname(relativePath).toLowerCase();
  if (EXCLUDE_EXTENSIONS.has(ext)) return true;
  if (sizeBytes !== undefined && sizeBytes > MAX_FILE_BYTES) return true;
  return false;
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
        if (shouldExclude(relativePath, obj.Size)) continue;

        const localFilePath = path.join(localPath, relativePath);
        fs.mkdirSync(path.dirname(localFilePath), { recursive: true });

        const getResp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: obj.Key }));

        if (getResp.Body) {
          const bytes = await getResp.Body.transformToByteArray();
          fs.writeFileSync(localFilePath, bytes);
        }
      }

      continuationToken = listResp.IsTruncated ? listResp.NextContinuationToken : undefined;
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

  async function uploadDir(dirPath: string, s3Prefix: string, relPrefix: string): Promise<void> {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (shouldExclude(rel)) continue;
      if (entry.isDirectory()) {
        await uploadDir(fullPath, `${s3Prefix}/${entry.name}`, rel);
      } else if (entry.isFile()) {
        const body = fs.readFileSync(fullPath);
        if (shouldExclude(rel, body.length)) continue;
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

  await uploadDir(localPath, prefix, "");
}
