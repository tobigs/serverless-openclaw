import { describe, it, expect, beforeEach, vi } from "vitest";

// Use vi.hoisted to ensure mock references are stable
const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn().mockImplementation(() => ({ send: mockSend })),
  },
  PutCommand: vi.fn().mockImplementation((params) => ({
    ...params,
    _type: "PutCommand",
  })),
  DeleteCommand: vi.fn().mockImplementation((params) => ({
    ...params,
    _type: "DeleteCommand",
  })),
}));

import { SessionLock } from "../src/session-lock.js";

describe("SessionLock", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  describe("acquire", () => {
    it("should acquire lock successfully when no existing lock", async () => {
      mockSend.mockResolvedValueOnce({});

      const lock = new SessionLock("user-123");
      const result = await lock.acquire();

      expect(result).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("should fail to acquire when ConditionalCheckFailedException", async () => {
      mockSend.mockRejectedValueOnce({ name: "ConditionalCheckFailedException" });

      const lock = new SessionLock("user-123");
      const result = await lock.acquire();

      expect(result).toBe(false);
    });

    it("should rethrow unexpected errors", async () => {
      mockSend.mockRejectedValueOnce(new Error("NetworkError"));

      const lock = new SessionLock("user-123");
      await expect(lock.acquire()).rejects.toThrow("NetworkError");
    });
  });

  describe("release", () => {
    it("should release lock successfully", async () => {
      mockSend.mockResolvedValueOnce({});

      const lock = new SessionLock("user-123");
      await expect(lock.release()).resolves.toBeUndefined();

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("should not throw when releasing already-released lock", async () => {
      mockSend.mockRejectedValueOnce({ name: "ConditionalCheckFailedException" });

      const lock = new SessionLock("user-123");
      await expect(lock.release()).resolves.toBeUndefined();
    });

    it("should not throw when release encounters any error", async () => {
      mockSend.mockRejectedValueOnce(new Error("SomeOtherError"));

      const lock = new SessionLock("user-123");
      await expect(lock.release()).resolves.toBeUndefined();
    });
  });
});
