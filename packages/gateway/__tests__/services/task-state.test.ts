import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTaskState, putTaskState, updateLastActivity } from "../../src/services/task-state.js";

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  GetCommand: vi.fn((params: unknown) => ({ input: params, _tag: "GetCommand" })),
  PutCommand: vi.fn((params: unknown) => ({ input: params, _tag: "PutCommand" })),
  DeleteCommand: vi.fn((params: unknown) => ({ input: params, _tag: "DeleteCommand" })),
  UpdateCommand: vi.fn((params: unknown) => ({ input: params, _tag: "UpdateCommand" })),
}));

describe("task-state service", () => {
  const mockSend = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getTaskState", () => {
    it("should return TaskStateItem when found", async () => {
      const item = {
        PK: "USER#user-123",
        taskArn: "arn:aws:ecs:us-east-1:123:task/cluster/abc",
        status: "Running",
        publicIp: "1.2.3.4",
        startedAt: "2024-01-01T00:00:00Z",
        lastActivity: "2024-01-01T00:05:00Z",
      };
      mockSend.mockResolvedValueOnce({ Item: item });

      const result = await getTaskState(mockSend, "user-123");

      expect(result).toEqual(item);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            TableName: expect.stringContaining("TaskState"),
            Key: { PK: "USER#user-123" },
          }),
        }),
      );
    });

    it("should return null when not found", async () => {
      mockSend.mockResolvedValueOnce({ Item: undefined });

      const result = await getTaskState(mockSend, "user-999");

      expect(result).toBeNull();
    });

    it("should return null for Idle status", async () => {
      const item = {
        PK: "USER#user-123",
        taskArn: "arn:old",
        status: "Idle",
        startedAt: "2024-01-01T00:00:00Z",
        lastActivity: "2024-01-01T00:05:00Z",
      };
      mockSend.mockResolvedValueOnce({ Item: item });

      const result = await getTaskState(mockSend, "user-123");

      expect(result).toBeNull();
    });
  });

  describe("putTaskState", () => {
    it("should put a TaskStateItem", async () => {
      mockSend.mockResolvedValueOnce({});

      const item = {
        PK: "USER#user-123",
        taskArn: "arn:aws:ecs:us-east-1:123:task/cluster/abc",
        status: "Starting" as const,
        startedAt: "2024-01-01T00:00:00Z",
        lastActivity: "2024-01-01T00:00:00Z",
      };

      await putTaskState(mockSend, item);

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            TableName: expect.stringContaining("TaskState"),
            Item: item,
          }),
        }),
      );
    });

    it("should include TTL when provided", async () => {
      mockSend.mockResolvedValueOnce({});

      const item = {
        PK: "USER#user-123",
        taskArn: "arn:task",
        status: "Running" as const,
        startedAt: "2024-01-01T00:00:00Z",
        lastActivity: "2024-01-01T00:00:00Z",
        ttl: 9999999999,
      };

      await putTaskState(mockSend, item);

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Item: expect.objectContaining({ ttl: 9999999999 }),
          }),
        }),
      );
    });
  });

  describe("updateLastActivity", () => {
    it("should issue an UpdateCommand touching only lastActivity", async () => {
      mockSend.mockResolvedValueOnce({});

      await updateLastActivity(mockSend, "user-123");

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          _tag: "UpdateCommand",
          input: expect.objectContaining({
            TableName: expect.stringContaining("TaskState"),
            Key: { PK: "USER#user-123" },
            UpdateExpression: "SET lastActivity = :la",
            ExpressionAttributeValues: expect.objectContaining({
              ":la": expect.any(String),
            }),
          }),
        }),
      );
    });
  });
});
