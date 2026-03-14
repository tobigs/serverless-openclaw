import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import fs from "node:fs";
import path from "node:path";

/**
 * Syncs OpenClaw session files between S3 and Lambda /tmp.
 *
 * S3 layout: s3://{bucket}/sessions/{userId}/{sessionId}.jsonl
 * Local layout: {localBase}/agents/default/sessions/{sessionId}.jsonl
 */
const SAFE_ID = /^[a-zA-Z0-9_:-]{1,128}$/;

function validateId(value: string, name: string): void {
  if (!SAFE_ID.test(value)) {
    throw new Error(`Invalid ${name}: must be 1-128 alphanumeric/dash/underscore/colon characters`);
  }
}

export class SessionSync {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly localBase: string;

  constructor(bucket: string, localBase: string) {
    this.s3 = new S3Client({});
    this.bucket = bucket;
    this.localBase = localBase;
  }

  /**
   * Download a session file from S3 to local /tmp.
   * Returns the local file path.
   * For new sessions (file not in S3), returns the expected path without creating the file.
   */
  async download(userId: string, sessionId: string): Promise<string> {
    const localPath = this.getLocalPath(sessionId);
    const s3Key = this.getS3Key(userId, sessionId);

    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(localPath), { recursive: true });

    try {
      const response = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: s3Key }),
      );
      const content = await response.Body!.transformToString();
      fs.writeFileSync(localPath, content, "utf-8");
    } catch (err: unknown) {
      if (isNoSuchKeyError(err)) {
        // New session — no file in S3 yet, that's fine
        return localPath;
      }
      throw err;
    }

    return localPath;
  }

  /**
   * Upload a session file from local /tmp to S3.
   * Skips if the local file does not exist (no-op for sessions that were never written).
   */
  async upload(userId: string, sessionId: string): Promise<void> {
    const localPath = this.getLocalPath(sessionId);

    if (!fs.existsSync(localPath)) {
      return;
    }

    const content = fs.readFileSync(localPath, "utf-8");
    const s3Key = this.getS3Key(userId, sessionId);

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
        Body: content,
        ContentType: "application/x-ndjson",
      }),
    );
  }

  /** Get the local file path for a session. */
  getLocalPath(sessionId: string): string {
    return path.join(
      this.localBase,
      "agents",
      "default",
      "sessions",
      `${sessionId}.jsonl`,
    );
  }

  private getS3Key(userId: string, sessionId: string): string {
    validateId(userId, "userId");
    validateId(sessionId, "sessionId");
    return `sessions/${userId}/${sessionId}.jsonl`;
  }
}

function isNoSuchKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "NoSuchKey"
  );
}
