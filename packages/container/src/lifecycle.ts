import { PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  TABLE_NAMES,
  KEY_PREFIX,
  PERIODIC_BACKUP_INTERVAL_MS,
  SESSION_S3_PREFIX,
  SESSION_DEFAULT_AGENT,
} from "@serverless-openclaw/shared";
import type { TaskStatus } from "@serverless-openclaw/shared";
import { backupToS3, restoreFromS3 } from "./s3-sync.js";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import * as fs from "node:fs";

const OPENCLAW_HOME_S3_PREFIX = "openclaw-home";

interface LifecycleDeps {
  dynamoSend: (command: unknown) => Promise<unknown>;
  userId: string;
  taskArn: string;
  s3Bucket: string;
  s3Prefix: string;
  workspacePath: string;
  /** Path to OpenClaw sessions directory (e.g., /home/openclaw/.openclaw) */
  openclawHome?: string;
}

export class LifecycleManager {
  private deps: LifecycleDeps;
  private backupTimer: ReturnType<typeof setInterval> | null = null;
  private _lastActivity: Date;

  constructor(deps: LifecycleDeps) {
    this.deps = deps;
    this._lastActivity = new Date();
  }

  get lastActivityTime(): Date {
    return this._lastActivity;
  }

  updateLastActivity(): void {
    this._lastActivity = new Date();
  }

  async updateTaskState(status: TaskStatus, publicIp?: string): Promise<void> {
    const item: Record<string, unknown> = {
      PK: `${KEY_PREFIX.USER}${this.deps.userId}`,
      taskArn: this.deps.taskArn,
      status,
      startedAt: new Date().toISOString(),
      lastActivity: this._lastActivity.toISOString(),
    };
    if (publicIp) {
      item.publicIp = publicIp;
    }
    if (status === "Idle") {
      item.ttl = Math.floor(Date.now() / 1000) + 86400; // 24h TTL for idle
    }
    await this.deps.dynamoSend(
      new PutCommand({
        TableName: TABLE_NAMES.TASK_STATE,
        Item: item,
      }),
    );
  }

  /** Restore openclaw.json from S3 before patch-config runs. Non-fatal if missing. */
  async restoreConfigFromS3(): Promise<void> {
    if (!this.deps.openclawHome) return;
    const configPath = `${this.deps.openclawHome}/openclaw.json`;
    const s3Key = `${OPENCLAW_HOME_S3_PREFIX}/${this.deps.userId}/openclaw.json`;
    try {
      const client = new S3Client({});
      const resp = await client.send(
        new GetObjectCommand({ Bucket: this.deps.s3Bucket, Key: s3Key }),
      );
      if (resp.Body) {
        const bytes = await resp.Body.transformToByteArray();
        fs.mkdirSync(this.deps.openclawHome, { recursive: true });
        fs.writeFileSync(configPath, bytes);
        console.log("[lifecycle] Restored openclaw.json from S3");
      }
    } catch {
      // First launch or no config in S3 — patch-config will build from scratch
    }
  }

  /** Backup openclaw.json to S3 after each periodic backup. */
  private async backupConfigToS3(): Promise<void> {
    if (!this.deps.openclawHome) return;
    const configPath = `${this.deps.openclawHome}/openclaw.json`;
    if (!fs.existsSync(configPath)) return;
    const s3Key = `${OPENCLAW_HOME_S3_PREFIX}/${this.deps.userId}/openclaw.json`;
    try {
      const client = new S3Client({});
      const body = fs.readFileSync(configPath);
      await client.send(
        new PutObjectCommand({ Bucket: this.deps.s3Bucket, Key: s3Key, Body: body }),
      );
    } catch (err) {
      console.warn("[lifecycle] Failed to backup openclaw.json to S3:", err);
    }
  }

  async backupToS3(): Promise<void> {
    await backupToS3({
      bucket: this.deps.s3Bucket,
      prefix: this.deps.s3Prefix,
      localPath: this.deps.workspacePath,
    });
    // Sync OpenClaw sessions to unified S3 path (shared with Lambda agent)
    if (this.deps.openclawHome) {
      const sessionsLocalPath = `${this.deps.openclawHome}/agents/${SESSION_DEFAULT_AGENT}/sessions`;
      await backupToS3({
        bucket: this.deps.s3Bucket,
        prefix: `${SESSION_S3_PREFIX}/${this.deps.userId}/agents/${SESSION_DEFAULT_AGENT}/sessions`,
        localPath: sessionsLocalPath,
      });
      await this.backupConfigToS3();
    }
  }

  /** Restore sessions from unified S3 path (populated by Lambda or previous Fargate) */
  async restoreSessionsFromS3(): Promise<void> {
    if (!this.deps.openclawHome) return;
    const sessionsLocalPath = `${this.deps.openclawHome}/agents/${SESSION_DEFAULT_AGENT}/sessions`;
    await restoreFromS3({
      bucket: this.deps.s3Bucket,
      prefix: `${SESSION_S3_PREFIX}/${this.deps.userId}/agents/${SESSION_DEFAULT_AGENT}/sessions`,
      localPath: sessionsLocalPath,
    });
  }

  startPeriodicBackup(): void {
    this.backupTimer = setInterval(() => {
      this.backupToS3().catch(() => {
        // Backup failure is non-fatal
      });
    }, PERIODIC_BACKUP_INTERVAL_MS);
  }

  stopPeriodicBackup(): void {
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
  }

  async gracefulShutdown(): Promise<void> {
    this.stopPeriodicBackup();
    await this.backupToS3();
    await this.updateTaskState("Idle");
  }
}
