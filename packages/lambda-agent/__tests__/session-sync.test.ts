import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionSync } from "../src/session-sync.js";

// Mock S3 client
const mockSend = vi.fn();
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: mockSend })),
  GetObjectCommand: vi.fn().mockImplementation((params) => ({
    ...params,
    _type: "GetObjectCommand",
  })),
  PutObjectCommand: vi.fn().mockImplementation((params) => ({
    ...params,
    _type: "PutObjectCommand",
  })),
}));

describe("session-sync", () => {
  let tmpDir: string;
  let sync: SessionSync;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-sync-test-"));
    sync = new SessionSync("test-bucket", tmpDir);
    mockSend.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("download", () => {
    it("should download session file from S3 to local path", async () => {
      const sessionContent = '{"type":"session","version":3}\n';
      mockSend.mockResolvedValueOnce({
        Body: {
          transformToString: () => Promise.resolve(sessionContent),
        },
      });

      const localPath = await sync.download("user-123", "session-456");

      expect(localPath).toBe(
        path.join(tmpDir, "agents", "default", "sessions", "session-456.jsonl"),
      );
      expect(fs.existsSync(localPath)).toBe(true);
      expect(fs.readFileSync(localPath, "utf-8")).toBe(sessionContent);
    });

    it("should create parent directories if they don't exist", async () => {
      mockSend.mockResolvedValueOnce({
        Body: {
          transformToString: () => Promise.resolve("content"),
        },
      });

      await sync.download("user-123", "session-789");

      const dir = path.join(tmpDir, "agents", "default", "sessions");
      expect(fs.existsSync(dir)).toBe(true);
    });

    it("should return local path without downloading for new sessions (NoSuchKey)", async () => {
      mockSend.mockRejectedValueOnce({ name: "NoSuchKey" });

      const localPath = await sync.download("user-123", "new-session");

      expect(localPath).toBe(
        path.join(
          tmpDir,
          "agents",
          "default",
          "sessions",
          "new-session.jsonl",
        ),
      );
      // File should not exist for new sessions
      expect(fs.existsSync(localPath)).toBe(false);
    });

    it("should use correct S3 key format", async () => {
      mockSend.mockRejectedValueOnce({ name: "NoSuchKey" });

      await sync.download("user-123", "session-456");

      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      expect(GetObjectCommand).toHaveBeenCalledWith({
        Bucket: "test-bucket",
        Key: "sessions/user-123/session-456.jsonl",
      });
    });

    it("should rethrow non-NoSuchKey errors", async () => {
      mockSend.mockRejectedValueOnce(new Error("AccessDenied"));

      await expect(sync.download("user-123", "session-456")).rejects.toThrow(
        "AccessDenied",
      );
    });
  });

  describe("upload", () => {
    it("should upload session file from local to S3", async () => {
      const sessionContent = '{"type":"session","version":3}\n';
      const localPath = path.join(
        tmpDir,
        "agents",
        "default",
        "sessions",
        "session-456.jsonl",
      );
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, sessionContent);

      mockSend.mockResolvedValueOnce({});

      await sync.upload("user-123", "session-456");

      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      expect(PutObjectCommand).toHaveBeenCalledWith({
        Bucket: "test-bucket",
        Key: "sessions/user-123/session-456.jsonl",
        Body: sessionContent,
        ContentType: "application/x-ndjson",
      });
    });

    it("should skip upload if local file does not exist", async () => {
      await sync.upload("user-123", "nonexistent");

      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe("getLocalPath", () => {
    it("should return the expected local path", () => {
      const localPath = sync.getLocalPath("session-123");
      expect(localPath).toBe(
        path.join(
          tmpDir,
          "agents",
          "default",
          "sessions",
          "session-123.jsonl",
        ),
      );
    });
  });
});
