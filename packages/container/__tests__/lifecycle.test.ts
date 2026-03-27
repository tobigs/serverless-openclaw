import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LifecycleManager } from "../src/lifecycle.js";
import * as s3Sync from "../src/s3-sync.js";

const mockDynamoSend = vi.fn();

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn(() => ({ send: mockDynamoSend })),
  },
  PutCommand: vi.fn((params: unknown) => ({ input: params, _tag: "PutCommand" })),
  UpdateCommand: vi.fn((params: unknown) => ({ input: params, _tag: "UpdateCommand" })),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn(() => ({})),
}));

vi.mock("../src/s3-sync.js", () => ({
  backupToS3: vi.fn().mockResolvedValue(undefined),
  restoreFromS3: vi.fn().mockResolvedValue(undefined),
}));

describe("LifecycleManager", () => {
  let lifecycle: LifecycleManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockDynamoSend.mockResolvedValue({});

    lifecycle = new LifecycleManager({
      dynamoSend: mockDynamoSend,
      userId: "user-123",
      taskArn: "arn:aws:ecs:us-east-1:123456:task/my-cluster/abc123",
      s3Bucket: "my-backup-bucket",
      s3Prefix: "backups/user-123",
      workspacePath: "/data/workspace",
    });
  });

  afterEach(() => {
    lifecycle.stopPeriodicBackup();
    vi.useRealTimers();
  });

  it("should update TaskState to Starting", async () => {
    await lifecycle.updateTaskState("Starting");

    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: expect.stringContaining("TaskState"),
          Item: expect.objectContaining({
            PK: "USER#user-123",
            status: "Starting",
          }),
        }),
      }),
    );
  });

  it("should update TaskState to Running with publicIp", async () => {
    await lifecycle.updateTaskState("Running", "1.2.3.4");

    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Item: expect.objectContaining({
            status: "Running",
            publicIp: "1.2.3.4",
          }),
        }),
      }),
    );
  });

  it("should update TaskState to Idle on gracefulShutdown", async () => {
    await lifecycle.gracefulShutdown();

    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Item: expect.objectContaining({
            status: "Idle",
          }),
        }),
      }),
    );
  });

  it("should call backupToS3 with correct params", async () => {
    await lifecycle.backupToS3();

    expect(s3Sync.backupToS3).toHaveBeenCalledWith({
      bucket: "my-backup-bucket",
      prefix: "backups/user-123",
      localPath: "/data/workspace",
    });
  });

  it("should start and stop periodic backup", async () => {
    const backupSpy = vi.spyOn(lifecycle, "backupToS3").mockResolvedValue();

    lifecycle.startPeriodicBackup();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(backupSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(backupSpy).toHaveBeenCalledTimes(2);

    lifecycle.stopPeriodicBackup();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(backupSpy).toHaveBeenCalledTimes(2);
  });

  it("should track lastActivity", () => {
    const before = lifecycle.lastActivityTime;
    vi.advanceTimersByTime(1000);
    lifecycle.updateLastActivity();
    expect(lifecycle.lastActivityTime.getTime()).toBeGreaterThan(
      before.getTime(),
    );
  });

  it("should backup before shutdown", async () => {
    await lifecycle.gracefulShutdown();

    expect(s3Sync.backupToS3).toHaveBeenCalledWith({
      bucket: "my-backup-bucket",
      prefix: "backups/user-123",
      localPath: "/data/workspace",
    });
  });
});

describe("LifecycleManager with openclawHome", () => {
  let lifecycle: LifecycleManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockDynamoSend.mockResolvedValue({});

    lifecycle = new LifecycleManager({
      dynamoSend: mockDynamoSend,
      userId: "user-123",
      taskArn: "arn:aws:ecs:us-east-1:123456:task/my-cluster/abc123",
      s3Bucket: "my-backup-bucket",
      s3Prefix: "backups/user-123",
      workspacePath: "/data/workspace",
      openclawHome: "/home/openclaw/.openclaw",
    });
  });

  afterEach(() => {
    lifecycle.stopPeriodicBackup();
    vi.useRealTimers();
  });

  it("should backup openclaw home (excluding agents dir) to S3", async () => {
    await lifecycle.backupToS3();

    expect(s3Sync.backupToS3).toHaveBeenCalledWith({
      bucket: "my-backup-bucket",
      prefix: "openclaw-home/user-123",
      localPath: "/home/openclaw/.openclaw",
      excludeDirs: ["agents"],
    });
  });

  it("should backup sessions to unified S3 path", async () => {
    await lifecycle.backupToS3();

    expect(s3Sync.backupToS3).toHaveBeenCalledWith({
      bucket: "my-backup-bucket",
      prefix: "sessions/user-123/agents/default/sessions",
      localPath: "/home/openclaw/.openclaw/agents/default/sessions",
    });
  });

  it("should restore openclaw home from S3", async () => {
    await lifecycle.restoreOpenclawHomeFromS3();

    expect(s3Sync.restoreFromS3).toHaveBeenCalledWith({
      bucket: "my-backup-bucket",
      prefix: "openclaw-home/user-123",
      localPath: "/home/openclaw/.openclaw",
    });
  });

  it("should restore sessions from S3", async () => {
    await lifecycle.restoreSessionsFromS3();

    expect(s3Sync.restoreFromS3).toHaveBeenCalledWith({
      bucket: "my-backup-bucket",
      prefix: "sessions/user-123/agents/default/sessions",
      localPath: "/home/openclaw/.openclaw/agents/default/sessions",
    });
  });
});
