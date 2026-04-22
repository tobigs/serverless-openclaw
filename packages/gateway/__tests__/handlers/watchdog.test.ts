import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend, mockEcsSend, mockCloudWatchSend } = vi.hoisted(() => ({
  mockDynamoSend: vi.fn(),
  mockEcsSend: vi.fn(),
  mockCloudWatchSend: vi.fn(),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: vi.fn(() => ({ send: mockDynamoSend })) },
  ScanCommand: vi.fn((params: unknown) => ({ input: params, _tag: "ScanCommand" })),
  DeleteCommand: vi.fn((params: unknown) => ({ input: params, _tag: "DeleteCommand" })),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn(() => ({})),
}));

vi.mock("@aws-sdk/client-ecs", () => ({
  ECSClient: vi.fn(() => ({ send: mockEcsSend })),
  StopTaskCommand: vi.fn((params: unknown) => ({ input: params, _tag: "StopTaskCommand" })),
  DescribeTasksCommand: vi.fn((params: unknown) => ({
    input: params,
    _tag: "DescribeTasksCommand",
  })),
}));

vi.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: vi.fn(() => ({ send: mockCloudWatchSend })),
  GetMetricStatisticsCommand: vi.fn((input: unknown) => ({ input, _tag: "GetMetricStatistics" })),
}));

describe("watchdog handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ECS_CLUSTER_ARN", "arn:cluster");
    // Default: CW returns no data → fallback 30-min timeout
    mockCloudWatchSend.mockResolvedValue({ Datapoints: [] });
  });

  it("should stop tasks inactive for more than 30 minutes", async () => {
    const { handler } = await import("../../src/handlers/watchdog.js");

    const oldTime = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    mockDynamoSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "USER#user-1",
          taskArn: "arn:task-1",
          status: "Running",
          startedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
          lastActivity: oldTime,
        },
      ],
    });
    // DescribeTasksCommand returns RUNNING (task is alive but inactive)
    mockEcsSend.mockResolvedValueOnce({
      tasks: [{ lastStatus: "RUNNING" }],
    });
    mockEcsSend.mockResolvedValue({});
    mockDynamoSend.mockResolvedValue({});

    await handler();

    expect(mockEcsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          cluster: "arn:cluster",
          task: "arn:task-1",
          reason: expect.stringContaining("inactivity"),
        }),
      }),
    );
  });

  it("should skip tasks started less than 5 minutes ago", async () => {
    const { handler } = await import("../../src/handlers/watchdog.js");

    const recentTime = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    mockDynamoSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "USER#user-1",
          taskArn: "arn:task-1",
          status: "Running",
          startedAt: recentTime,
          lastActivity: recentTime,
        },
      ],
    });
    // DescribeTasksCommand returns RUNNING
    mockEcsSend.mockResolvedValueOnce({
      tasks: [{ lastStatus: "RUNNING" }],
    });

    await handler();

    // Should only call DescribeTasks, not StopTask
    expect(mockEcsSend).toHaveBeenCalledTimes(1);
    expect(mockEcsSend).toHaveBeenCalledWith(
      expect.objectContaining({ _tag: "DescribeTasksCommand" }),
    );
  });

  it("should skip tasks with recent activity", async () => {
    const { handler } = await import("../../src/handlers/watchdog.js");

    const recentActivity = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    mockDynamoSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "USER#user-1",
          taskArn: "arn:task-1",
          status: "Running",
          startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          lastActivity: recentActivity,
        },
      ],
    });
    // DescribeTasksCommand returns RUNNING
    mockEcsSend.mockResolvedValueOnce({
      tasks: [{ lastStatus: "RUNNING" }],
    });

    await handler();

    // Should only call DescribeTasks, not StopTask
    expect(mockEcsSend).toHaveBeenCalledTimes(1);
    expect(mockEcsSend).toHaveBeenCalledWith(
      expect.objectContaining({ _tag: "DescribeTasksCommand" }),
    );
  });

  it("should handle empty scan result", async () => {
    const { handler } = await import("../../src/handlers/watchdog.js");

    mockDynamoSend.mockResolvedValueOnce({ Items: [] });

    await handler();

    expect(mockEcsSend).not.toHaveBeenCalled();
  });

  it("should clean up stale Starting entries when ECS task is stopped", async () => {
    const { handler } = await import("../../src/handlers/watchdog.js");

    const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    mockDynamoSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "USER#user-1",
          taskArn: "arn:task-stale",
          status: "Starting",
          startedAt: staleTime,
          lastActivity: staleTime,
        },
      ],
    });
    // DescribeTasksCommand returns STOPPED
    mockEcsSend.mockResolvedValueOnce({
      tasks: [{ lastStatus: "STOPPED" }],
    });
    mockDynamoSend.mockResolvedValue({});

    await handler();

    // Should delete the stale TaskState entry
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: expect.stringContaining("TaskState"),
          Key: { PK: "USER#user-1" },
        }),
      }),
    );
  });

  it("should not clean up Starting entries younger than 10 minutes", async () => {
    const { handler } = await import("../../src/handlers/watchdog.js");

    const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    mockDynamoSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "USER#user-1",
          taskArn: "arn:task-recent",
          status: "Starting",
          startedAt: recentTime,
          lastActivity: recentTime,
        },
      ],
    });

    await handler();

    // Should not call DescribeTasks or Delete
    expect(mockEcsSend).not.toHaveBeenCalled();
    expect(mockDynamoSend).toHaveBeenCalledTimes(1); // only the scan
  });

  it("should clean up stale Running entries when ECS task is actually stopped", async () => {
    const { handler } = await import("../../src/handlers/watchdog.js");

    const oldTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    mockDynamoSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "USER#user-1",
          taskArn: "arn:task-stale-running",
          status: "Running",
          publicIp: "1.2.3.4",
          startedAt: oldTime,
          lastActivity: oldTime,
        },
      ],
    });
    // DescribeTasksCommand returns STOPPED
    mockEcsSend.mockResolvedValueOnce({
      tasks: [{ lastStatus: "STOPPED" }],
    });
    mockDynamoSend.mockResolvedValue({});

    await handler();

    // Should verify ECS task status before inactivity check
    expect(mockEcsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        _tag: "DescribeTasksCommand",
        input: expect.objectContaining({
          cluster: "arn:cluster",
          tasks: ["arn:task-stale-running"],
        }),
      }),
    );

    // Should delete the stale TaskState entry
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: expect.stringContaining("TaskState"),
          Key: { PK: "USER#user-1" },
        }),
      }),
    );
  });

  it("should proceed with normal timeout logic when ECS task is still running", async () => {
    const { handler } = await import("../../src/handlers/watchdog.js");

    // Task with recent activity — should NOT be stopped
    const recentActivity = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    mockDynamoSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "USER#user-1",
          taskArn: "arn:task-running",
          status: "Running",
          publicIp: "1.2.3.4",
          startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          lastActivity: recentActivity,
        },
      ],
    });
    // DescribeTasksCommand returns RUNNING
    mockEcsSend.mockResolvedValueOnce({
      tasks: [{ lastStatus: "RUNNING" }],
    });

    await handler();

    // Should NOT stop or delete — task is legitimately running with recent activity
    expect(mockEcsSend).toHaveBeenCalledTimes(1); // only DescribeTasks, no StopTask
  });

  it("should skip tasks under prewarm protection (prewarmUntil in the future)", async () => {
    const { handler } = await import("../../src/handlers/watchdog.js");

    const oldTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    mockDynamoSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "USER#system:prewarm",
          taskArn: "arn:prewarm-task",
          status: "Running",
          publicIp: "1.2.3.4",
          startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          lastActivity: oldTime,
          prewarmUntil: Date.now() + 30 * 60 * 1000, // 30 min in the future
        },
      ],
    });
    // DescribeTasksCommand returns RUNNING
    mockEcsSend.mockResolvedValueOnce({
      tasks: [{ lastStatus: "RUNNING" }],
    });

    await handler();

    // Should call DescribeTasks for ECS verification, but NOT StopTask
    expect(mockEcsSend).toHaveBeenCalledTimes(1);
    expect(mockEcsSend).toHaveBeenCalledWith(
      expect.objectContaining({ _tag: "DescribeTasksCommand" }),
    );
  });

  it("should stop tasks with expired prewarmUntil when inactive", async () => {
    const { handler } = await import("../../src/handlers/watchdog.js");

    const oldTime = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    mockDynamoSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "USER#system:prewarm",
          taskArn: "arn:prewarm-task",
          status: "Running",
          publicIp: "1.2.3.4",
          startedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
          lastActivity: oldTime,
          prewarmUntil: Date.now() - 5 * 60 * 1000, // expired 5 min ago
        },
      ],
    });
    // DescribeTasksCommand returns RUNNING
    mockEcsSend.mockResolvedValueOnce({
      tasks: [{ lastStatus: "RUNNING" }],
    });
    mockEcsSend.mockResolvedValue({});
    mockDynamoSend.mockResolvedValue({});

    await handler();

    // Should stop the task — prewarm expired and inactive > timeout
    expect(mockEcsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          task: "arn:prewarm-task",
          reason: expect.stringContaining("inactivity"),
        }),
      }),
    );
  });

  describe("dynamic timeout", () => {
    it("should use 30-min timeout during active hours (>= 2 datapoints at current hour)", async () => {
      const { handler } = await import("../../src/handlers/watchdog.js");

      const now = new Date();
      const currentHourKST = (now.getUTCHours() + 9) % 24;

      // Return datapoints matching current KST hour for both channels
      mockCloudWatchSend.mockResolvedValue({
        Datapoints: [
          { Timestamp: createTimestampForKSTHour(currentHourKST, 1), SampleCount: 5 },
          { Timestamp: createTimestampForKSTHour(currentHourKST, 2), SampleCount: 3 },
        ],
      });

      // Task inactive for 25 min — would be stopped with 15-min default,
      // but should NOT be stopped with 30-min active timeout
      const lastActivity = new Date(Date.now() - 25 * 60 * 1000).toISOString();
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "USER#user-1",
            taskArn: "arn:task-1",
            status: "Running",
            startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            lastActivity,
          },
        ],
      });
      // DescribeTasksCommand returns RUNNING
      mockEcsSend.mockResolvedValueOnce({
        tasks: [{ lastStatus: "RUNNING" }],
      });

      await handler();

      // Should only call DescribeTasks, not StopTask — 25 min < 30 min active timeout
      expect(mockEcsSend).toHaveBeenCalledTimes(1);
      expect(mockEcsSend).toHaveBeenCalledWith(
        expect.objectContaining({ _tag: "DescribeTasksCommand" }),
      );
    });

    it("should use 30-min timeout during inactive hours (< 2 total datapoints at current hour)", async () => {
      const { handler } = await import("../../src/handlers/watchdog.js");

      const now = new Date();
      const currentHourKST = (now.getUTCHours() + 9) % 24;

      // First channel (telegram): 1 datapoint at current hour
      mockCloudWatchSend.mockResolvedValueOnce({
        Datapoints: [{ Timestamp: createTimestampForKSTHour(currentHourKST, 1), SampleCount: 1 }],
      });
      // Second channel (web): 0 datapoints → total = 1, below threshold of 2
      mockCloudWatchSend.mockResolvedValueOnce({
        Datapoints: [],
      });

      // Task inactive for 35 min — exceeds the 30-min inactive timeout
      const lastActivity = new Date(Date.now() - 35 * 60 * 1000).toISOString();
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "USER#user-1",
            taskArn: "arn:task-1",
            status: "Running",
            startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            lastActivity,
          },
        ],
      });
      // DescribeTasksCommand returns RUNNING
      mockEcsSend.mockResolvedValueOnce({
        tasks: [{ lastStatus: "RUNNING" }],
      });
      mockEcsSend.mockResolvedValue({});
      mockDynamoSend.mockResolvedValue({});

      await handler();

      // Should stop — 35 min > 30 min inactive timeout
      expect(mockEcsSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            task: "arn:task-1",
            reason: expect.stringContaining("inactivity"),
          }),
        }),
      );
    });

    it("should fall back to 15-min timeout on CloudWatch error", async () => {
      const { handler } = await import("../../src/handlers/watchdog.js");

      mockCloudWatchSend.mockRejectedValue(new Error("CW API error"));

      // Task inactive for 12 min — should NOT be stopped with 15-min fallback
      const lastActivity = new Date(Date.now() - 12 * 60 * 1000).toISOString();
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "USER#user-1",
            taskArn: "arn:task-1",
            status: "Running",
            startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            lastActivity,
          },
        ],
      });
      // DescribeTasksCommand returns RUNNING
      mockEcsSend.mockResolvedValueOnce({
        tasks: [{ lastStatus: "RUNNING" }],
      });

      await handler();

      // Should only call DescribeTasks, not StopTask — 12 min < 15 min fallback
      expect(mockEcsSend).toHaveBeenCalledTimes(1);
      expect(mockEcsSend).toHaveBeenCalledWith(
        expect.objectContaining({ _tag: "DescribeTasksCommand" }),
      );
    });

    it("should fall back to 30-min timeout when CW returns empty data", async () => {
      const { handler } = await import("../../src/handlers/watchdog.js");

      mockCloudWatchSend.mockResolvedValue({ Datapoints: [] });

      // Task inactive for 35 min — should be stopped with 30-min fallback
      const lastActivity = new Date(Date.now() - 35 * 60 * 1000).toISOString();
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "USER#user-1",
            taskArn: "arn:task-1",
            status: "Running",
            startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            lastActivity,
          },
        ],
      });
      // DescribeTasksCommand returns RUNNING
      mockEcsSend.mockResolvedValueOnce({
        tasks: [{ lastStatus: "RUNNING" }],
      });
      mockEcsSend.mockResolvedValue({});
      mockDynamoSend.mockResolvedValue({});

      await handler();

      // Should stop — 35 min > 30 min fallback
      expect(mockEcsSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            task: "arn:task-1",
            reason: expect.stringContaining("inactivity"),
          }),
        }),
      );
    });

    it("should query both telegram and web channels", async () => {
      const { handler } = await import("../../src/handlers/watchdog.js");

      mockCloudWatchSend.mockResolvedValue({ Datapoints: [] });
      mockDynamoSend.mockResolvedValueOnce({ Items: [] });

      await handler();

      expect(mockCloudWatchSend).toHaveBeenCalledTimes(2);

      const calls = mockCloudWatchSend.mock.calls;
      const dimensions = calls.map(
        (call: [{ input: { Dimensions: Array<{ Name: string; Value: string }> } }]) =>
          call[0].input.Dimensions[0].Value,
      );
      expect(dimensions).toContain("telegram");
      expect(dimensions).toContain("web");
    });

    it("should only count datapoints matching current KST hour", async () => {
      const { handler } = await import("../../src/handlers/watchdog.js");

      const now = new Date();
      const currentHourKST = (now.getUTCHours() + 9) % 24;
      const differentHourKST = (currentHourKST + 5) % 24;

      // Return datapoints at a different hour — should NOT count
      mockCloudWatchSend.mockResolvedValue({
        Datapoints: [
          { Timestamp: createTimestampForKSTHour(differentHourKST, 1), SampleCount: 10 },
          { Timestamp: createTimestampForKSTHour(differentHourKST, 2), SampleCount: 10 },
          { Timestamp: createTimestampForKSTHour(differentHourKST, 3), SampleCount: 10 },
        ],
      });

      // Task inactive for 12 min — with 0 matching datapoints, falls back to 15-min default
      const lastActivity = new Date(Date.now() - 12 * 60 * 1000).toISOString();
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          {
            PK: "USER#user-1",
            taskArn: "arn:task-1",
            status: "Running",
            startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            lastActivity,
          },
        ],
      });
      // DescribeTasksCommand returns RUNNING
      mockEcsSend.mockResolvedValueOnce({
        tasks: [{ lastStatus: "RUNNING" }],
      });

      await handler();

      // Should only call DescribeTasks, not StopTask — 12 min < 15 min fallback
      expect(mockEcsSend).toHaveBeenCalledTimes(1);
      expect(mockEcsSend).toHaveBeenCalledWith(
        expect.objectContaining({ _tag: "DescribeTasksCommand" }),
      );
    });
  });
});

/**
 * Create a Date that falls at the given KST hour, offset by daysAgo days.
 */
function createTimestampForKSTHour(kstHour: number, daysAgo: number): Date {
  const now = new Date();
  const utcHour = (kstHour - 9 + 24) % 24;
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(utcHour, 30, 0, 0); // :30 minutes into the hour
  return d;
}
