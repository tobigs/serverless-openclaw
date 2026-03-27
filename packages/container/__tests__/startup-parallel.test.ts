import { describe, it, expect, vi, beforeEach } from "vitest";

// Track call order for parallelization verification
const callOrder: string[] = [];

const mockRestoreFromS3 = vi.fn(async () => {
  callOrder.push("restoreFromS3");
});

const mockLoadRecentHistory = vi.fn(async () => {
  callOrder.push("loadRecentHistory");
  return [];
});

const mockFormatHistoryContext = vi.fn(() => "");
const mockSaveMessagePair = vi.fn(async () => {});

const mockWaitForPort = vi.fn(async () => {
  callOrder.push("waitForPort");
});

const mockNotifyTelegram = vi.fn(async () => {});
const mockGetTelegramChatId = vi.fn((userId: string) =>
  userId.startsWith("telegram:") ? userId.slice(9) : null,
);

const mockWaitForReady = vi.fn(async () => {
  callOrder.push("waitForReady");
});
const mockClose = vi.fn();
const mockSendMessage = vi.fn();

const mockDiscoverPublicIp = vi.fn(async () => {
  callOrder.push("discoverPublicIp");
  return "1.2.3.4";
});

const mockUpdateTaskState = vi.fn(async (...args: unknown[]) => {
  callOrder.push(args[1] ? "updateTaskState:withIp" : "updateTaskState");
});

const mockConsumePendingMessages = vi.fn(async () => {
  callOrder.push("consumePendingMessages");
  return 0;
});

const mockListen = vi.fn(
  (_port: number, _host: string, cb: () => void) => {
    callOrder.push("listen");
    cb();
    return { close: vi.fn() };
  },
);

const mockPublishStartupMetrics = vi.fn(async () => {});
const mockPublishMessageMetrics = vi.fn(async () => {});
const mockStartPeriodicBackup = vi.fn();

vi.mock("../src/s3-sync.js", () => ({
  restoreFromS3: (...args: unknown[]) => mockRestoreFromS3(...args),
}));

vi.mock("../src/conversation-store.js", () => ({
  loadRecentHistory: (...args: unknown[]) => mockLoadRecentHistory(...args),
  formatHistoryContext: (...args: unknown[]) =>
    mockFormatHistoryContext(...args),
  saveMessagePair: (...args: unknown[]) => mockSaveMessagePair(...args),
}));

vi.mock("../src/pending-messages.js", () => ({
  consumePendingMessages: (...args: unknown[]) =>
    mockConsumePendingMessages(...args),
}));

vi.mock("../src/metrics.js", () => ({
  publishStartupMetrics: (...args: unknown[]) =>
    mockPublishStartupMetrics(...args),
  publishMessageMetrics: (...args: unknown[]) =>
    mockPublishMessageMetrics(...args),
}));

vi.mock("../src/discover-public-ip.js", () => ({
  discoverPublicIp: (...args: unknown[]) => mockDiscoverPublicIp(...args),
}));

vi.mock("../src/utils.js", () => ({
  waitForPort: (...args: unknown[]) => mockWaitForPort(...args),
  notifyTelegram: (...args: unknown[]) => mockNotifyTelegram(...args),
  getTelegramChatId: (...args: unknown[]) => mockGetTelegramChatId(...args),
}));

vi.mock("../src/bridge.js", () => ({
  createApp: vi.fn(() => ({
    listen: mockListen,
  })),
}));

vi.mock("../src/openclaw-client.js", () => ({
  OpenClawClient: vi.fn(() => ({
    waitForReady: mockWaitForReady,
    close: mockClose,
    sendMessage: mockSendMessage,
  })),
}));

vi.mock("../src/callback-sender.js", () => ({
  CallbackSender: vi.fn(() => ({
    send: vi.fn(),
  })),
}));

vi.mock("../src/lifecycle.js", () => ({
  LifecycleManager: vi.fn(() => ({
    updateTaskState: mockUpdateTaskState,
    startPeriodicBackup: mockStartPeriodicBackup,
    stopPeriodicBackup: vi.fn(),
    gracefulShutdown: vi.fn(),
    updateLastActivity: vi.fn(),
  })),
}));

import { startContainer } from "../src/startup.js";

function defaultOpts() {
  return {
    env: {
      BRIDGE_AUTH_TOKEN: "token",
      OPENCLAW_GATEWAY_TOKEN: "gw-token",
      USER_ID: "user-1",
      DATA_BUCKET: "bucket",
      CALLBACK_URL: "https://callback",
    },
    taskMetadata: { taskArn: "arn:task", cluster: "cluster" },
    dynamoSend: vi.fn().mockResolvedValue({}),
    ecsSend: vi.fn(),
    ec2Send: vi.fn(),
  };
}

describe("startContainer - parallel startup", () => {
  beforeEach(() => {
    callOrder.length = 0;
    vi.clearAllMocks();
    // Re-set default implementations after clearAllMocks
    mockRestoreFromS3.mockImplementation(async () => {
      callOrder.push("restoreFromS3");
    });
    mockLoadRecentHistory.mockImplementation(async () => {
      callOrder.push("loadRecentHistory");
      return [];
    });
    mockFormatHistoryContext.mockReturnValue("");
    mockWaitForPort.mockImplementation(async () => {
      callOrder.push("waitForPort");
    });
    mockWaitForReady.mockImplementation(async () => {
      callOrder.push("waitForReady");
    });
    mockDiscoverPublicIp.mockImplementation(async () => {
      callOrder.push("discoverPublicIp");
      return "1.2.3.4";
    });
    mockUpdateTaskState.mockImplementation(async (...args: unknown[]) => {
      callOrder.push(args[1] ? "updateTaskState:withIp" : "updateTaskState");
    });
    mockConsumePendingMessages.mockImplementation(async () => {
      callOrder.push("consumePendingMessages");
      return 0;
    });
    mockListen.mockImplementation(
      (_port: number, _host: string, cb: () => void) => {
        callOrder.push("listen");
        cb();
        return { close: vi.fn() };
      },
    );
    mockGetTelegramChatId.mockImplementation((userId: string) =>
      userId.startsWith("telegram:") ? userId.slice(9) : null,
    );
  });

  it("should run S3 restore and history load in parallel (both before gateway wait)", async () => {
    // Use delayed mocks to prove they start concurrently
    const s3Resolvers: Array<() => void> = [];
    let historyResolve!: (v: never[]) => void;

    mockRestoreFromS3.mockImplementation(() => {
      callOrder.push("restoreFromS3:start");
      return new Promise<void>((r) => {
        s3Resolvers.push(() => {
          callOrder.push("restoreFromS3:end");
          r();
        });
      });
    });

    mockLoadRecentHistory.mockImplementation(() => {
      callOrder.push("loadRecentHistory:start");
      return new Promise<never[]>((r) => {
        historyResolve = (v: never[]) => {
          callOrder.push("loadRecentHistory:end");
          r(v);
        };
      });
    });

    const promise = startContainer(defaultOpts());

    // Wait for both S3 restores and history to start
    await vi.waitFor(() => {
      expect(callOrder.filter((c) => c === "restoreFromS3:start")).toHaveLength(2);
      expect(callOrder).toContain("loadRecentHistory:start");
    });

    // Gateway wait should NOT have been called yet (blocked by Promise.all)
    expect(callOrder).not.toContain("waitForPort");

    // Resolve all
    for (const resolve of s3Resolvers) resolve();
    historyResolve([] as never[]);

    await promise;
  });

  it("should wait for gateway and client after parallel phase completes", async () => {
    await startContainer(defaultOpts());

    const s3Idx = callOrder.indexOf("restoreFromS3");
    const historyIdx = callOrder.indexOf("loadRecentHistory");
    const gatewayIdx = callOrder.indexOf("waitForPort");
    const clientIdx = callOrder.indexOf("waitForReady");

    // Both parallel tasks must finish before gateway wait
    expect(gatewayIdx).toBeGreaterThan(s3Idx);
    expect(gatewayIdx).toBeGreaterThan(historyIdx);
    // Client must wait after gateway
    expect(clientIdx).toBeGreaterThan(gatewayIdx);
  });

  it("should make IP discovery non-blocking (fire-and-forget)", async () => {
    let ipResolve!: (v: string | null) => void;

    mockDiscoverPublicIp.mockImplementation(() => {
      callOrder.push("discoverPublicIp:start");
      return new Promise<string | null>((r) => {
        ipResolve = (v: string | null) => {
          callOrder.push("discoverPublicIp:end");
          r(v);
        };
      });
    });

    await startContainer(defaultOpts());

    // startContainer completed but IP discovery is still pending
    expect(callOrder).toContain("discoverPublicIp:start");
    expect(callOrder).not.toContain("discoverPublicIp:end");

    // TaskState "Running" was called without IP (first call)
    expect(mockUpdateTaskState).toHaveBeenCalledWith("Running");

    // Resolve IP discovery
    ipResolve("1.2.3.4");
    await new Promise((r) => setTimeout(r, 10));

    // After IP resolves, TaskState updated again with IP
    expect(mockUpdateTaskState).toHaveBeenCalledWith("Running", "1.2.3.4");
  });

  it("should catch IP discovery errors without crashing", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockDiscoverPublicIp.mockRejectedValue(new Error("EC2 API failed"));

    // startContainer should NOT throw
    await startContainer(defaultOpts());

    // Allow fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 10));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("IP discovery failed"),
      expect.any(Error),
    );

    consoleSpy.mockRestore();
  });

  it("should update TaskState to Running before consuming pending messages", async () => {
    await startContainer(defaultOpts());

    const firstRunningIdx = callOrder.indexOf("updateTaskState");
    const consumeIdx = callOrder.indexOf("consumePendingMessages");

    expect(firstRunningIdx).toBeGreaterThanOrEqual(0);
    expect(consumeIdx).toBeGreaterThan(firstRunningIdx);
  });

  it("should start bridge server before IP discovery", async () => {
    await startContainer(defaultOpts());

    const listenIdx = callOrder.indexOf("listen");
    const updateRunningIdx = callOrder.indexOf("updateTaskState");

    // Bridge server starts, then Running state update, then IP in background
    expect(listenIdx).toBeGreaterThan(-1);
    expect(updateRunningIdx).toBeGreaterThan(listenIdx);
  });

  it("should publish startup metrics after pending messages are consumed", async () => {
    await startContainer(defaultOpts());

    expect(mockPublishStartupMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        total: expect.any(Number),
        s3Restore: expect.any(Number),
        gatewayWait: expect.any(Number),
        clientReady: expect.any(Number),
        pendingMessages: 0,
        userId: "user-1",
        channel: "web",
      }),
    );
  });

  it("should start periodic backup after startup completes", async () => {
    await startContainer(defaultOpts());

    expect(mockStartPeriodicBackup).toHaveBeenCalledOnce();
  });
});
