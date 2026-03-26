import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import fs from "node:fs";
import path from "node:path";
import {
  WORKSPACE_S3_PREFIX,
  WORKSPACE_DEFAULT_ALLOWLIST,
  WORKSPACE_MAX_FILE_SIZE,
  WORKSPACE_MAX_TOTAL_SIZE,
} from "@serverless-openclaw/shared";

export interface WorkspaceSyncOptions {
  bucket: string;
  localPath: string;
  /** Glob patterns for files to sync. Defaults to WORKSPACE_DEFAULT_ALLOWLIST */
  allowlist?: string[];
  /** Max size per file in bytes. Default: 1 MB */
  maxFileSize?: number;
  /** Max total download size in bytes. Default: 50 MB */
  maxTotalSize?: number;
  /** Optional pre-configured S3Client (for testing) */
  s3Client?: S3Client;
}

const SAFE_ID = /^[a-zA-Z0-9_:-]{1,128}$/;

function validateId(value: string, name: string): void {
  if (!SAFE_ID.test(value)) {
    throw new Error(
      `Invalid ${name}: must be 1-128 alphanumeric/dash/underscore/colon characters`,
    );
  }
}

/**
 * Check whether a relative path matches any of the given allowlist patterns.
 * Supports exact match and `dir/**` wildcard (matches anything under `dir/`).
 */
export function matchesAllowlist(
  relativePath: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith("/**")) {
      const dir = pattern.slice(0, -3);
      return relativePath.startsWith(dir + "/");
    }
    return relativePath === pattern;
  });
}

/**
 * Syncs OpenClaw workspace files between S3 and Lambda /tmp.
 *
 * S3 layout (shared with Fargate):
 *   s3://{bucket}/workspaces/{userId}/{relativePath}
 * Local layout:
 *   {localPath}/{relativePath}
 */
export class WorkspaceSync {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly localPath: string;
  private readonly allowlist: readonly string[];
  private readonly maxFileSize: number;
  private readonly maxTotalSize: number;

  constructor(options: WorkspaceSyncOptions) {
    this.bucket = options.bucket;
    this.localPath = options.localPath;
    this.allowlist = options.allowlist ?? WORKSPACE_DEFAULT_ALLOWLIST;
    this.maxFileSize = options.maxFileSize ?? WORKSPACE_MAX_FILE_SIZE;
    this.maxTotalSize = options.maxTotalSize ?? WORKSPACE_MAX_TOTAL_SIZE;
    this.s3 = options.s3Client ?? new S3Client({});
  }

  /**
   * Download workspace files from S3 to localPath.
   * Lists objects under workspaces/{userId}/, filters by allowlist and size limits.
   * Logs warnings for skipped files. Non-fatal on errors (fail-open).
   */
  async download(userId: string): Promise<void> {
    validateId(userId, "userId");

    try {
      const prefix = `${WORKSPACE_S3_PREFIX}/${userId}/`;
      let continuationToken: string | undefined;
      let totalSize = 0;

      do {
        const listResp = await this.s3.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );

        for (const obj of listResp.Contents ?? []) {
          if (!obj.Key || obj.Key.endsWith("/")) continue;

          const relativePath = obj.Key.slice(prefix.length);
          if (!relativePath) continue;

          // Filter by allowlist
          if (!matchesAllowlist(relativePath, this.allowlist)) continue;

          // Skip files exceeding per-file size limit
          const fileSize = obj.Size ?? 0;
          if (fileSize > this.maxFileSize) {
            console.warn(
              `[workspace-sync] Skipping ${relativePath}: size ${fileSize} exceeds maxFileSize ${this.maxFileSize}`,
            );
            continue;
          }

          // Stop downloading when total size limit exceeded
          if (totalSize + fileSize > this.maxTotalSize) {
            console.warn(
              `[workspace-sync] Stopping download: total size would exceed maxTotalSize ${this.maxTotalSize}`,
            );
            return;
          }

          const getResp = await this.s3.send(
            new GetObjectCommand({ Bucket: this.bucket, Key: obj.Key }),
          );

          if (getResp.Body) {
            const bytes = await getResp.Body.transformToByteArray();
            const localFilePath = path.join(this.localPath, relativePath);
            fs.mkdirSync(path.dirname(localFilePath), { recursive: true });
            fs.writeFileSync(localFilePath, bytes);
            totalSize += fileSize;
          }
        }

        continuationToken = listResp.IsTruncated
          ? listResp.NextContinuationToken
          : undefined;
      } while (continuationToken);
    } catch (err) {
      console.error("[workspace-sync] download failed, continuing:", err);
    }
  }

  /**
   * Upload workspace files from localPath to S3.
   * Walks the local directory, filters by allowlist, uploads matching files.
   * Skips if localPath doesn't exist.
   */
  async upload(userId: string): Promise<void> {
    validateId(userId, "userId");

    if (!fs.existsSync(this.localPath)) return;

    const files = walkDir(this.localPath);

    for (const filePath of files) {
      const relativePath = path.relative(this.localPath, filePath);
      // Normalize to forward slashes for S3 key consistency
      const normalizedPath = relativePath.split(path.sep).join("/");

      if (!matchesAllowlist(normalizedPath, this.allowlist)) continue;

      const body = fs.readFileSync(filePath);
      const s3Key = `${WORKSPACE_S3_PREFIX}/${userId}/${normalizedPath}`;

      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: s3Key,
          Body: body,
        }),
      );
    }
  }
}

/** Recursively walk a directory and return all file paths. */
function walkDir(dirPath: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }

  return results;
}
