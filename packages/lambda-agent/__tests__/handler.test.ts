import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { LambdaAgentEvent, LambdaAgentResponse } from "../src/types.js";

// Use vi.hoisted to ensure mock references are stable across vi.resetModules()
const {
  mockInitConfig,
  mockDownload,
  mockUpload,
  mockResolveSecrets,
  mockRunAgent,
  mockAcquire,
  mockRelease,
} = vi.hoisted(() => ({
  mockInitConfig: vi.fn().mockResolvedValue({
    configDir: "/tmp/.openclaw",
    sessionsDir: "/tmp/.openclaw/agents/default/sessions",
  }),
  mockDownload: vi.fn().mockResolvedValue("/tmp/.openclaw/agents/default/sessions/test.jsonl"),
  mockUpload: vi.fn().mockResolvedValue(undefined),
  mockResolveSecrets: vi
    .fn()
    .mockResolvedValue(
      new Map([["/serverless-openclaw/secrets/anthropic-api-key", "test-api-key"]]),
    ),
  mockRunAgent: vi.fn(),
  mockAcquire: vi.fn().mockResolvedValue(true),
  mockRelease: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/config-init.js", () => ({
  initConfig: (...args: unknown[]) => mockInitConfig(...args),
}));

vi.mock("../src/session-sync.js", () => ({
  SessionSync: vi.fn().mockImplementation(() => ({
    download: mockDownload,
    upload: mockUpload,
    getLocalPath: (sid: string) => `/tmp/.openclaw/agents/default/sessions/${sid}.jsonl`,
  })),
}));

vi.mock("../src/secrets.js", () => ({
  resolveSecrets: (...args: unknown[]) => mockResolveSecrets(...args),
}));

vi.mock("../src/agent-runner.js", () => ({
  runAgent: (...args: unknown[]) => mockRunAgent(...args),
}));

vi.mock("../src/session-lock.js", () => ({
  SessionLock: vi.fn().mockImplementation(() => ({
    acquire: mockAcquire,
    release: mockRelease,
  })),
}));

describe("handler", () => {
  let originalBucket: string | undefined;
  let originalAiProvider: string | undefined;
  let originalAiModel: string | undefined;
  let originalAwsRegion: string | undefined;
  let originalBedrockRegion: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    mockInitConfig.mockClear();
    mockDownload.mockClear();
    mockUpload.mockClear();
    mockResolveSecrets.mockClear();
    mockRunAgent.mockClear();
    mockAcquire.mockClear();
    mockRelease.mockClear();

    // Set required env var
    originalBucket = process.env.SESSION_BUCKET;
    process.env.SESSION_BUCKET = "test-session-bucket";

    // Pin AI provider env vars so these tests don't inherit ambient shell/.env values
    // (e.g. AI_PROVIDER=bedrock from a local deployment .env). handler.ts resolves
    // providerConfig from process.env at module load time — tests must control it explicitly.
    originalAiProvider = process.env.AI_PROVIDER;
    originalAiModel = process.env.AI_MODEL;
    originalAwsRegion = process.env.AWS_REGION;
    originalBedrockRegion = process.env.BEDROCK_REGION;
    process.env.AI_PROVIDER = "anthropic";
    delete process.env.AI_MODEL;
    delete process.env.AWS_REGION;
    delete process.env.BEDROCK_REGION;

    mockRunAgent.mockResolvedValue({
      payloads: [{ text: "Hello from agent!" }],
      meta: {
        durationMs: 1000,
        agentMeta: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      },
    });
  });

  afterEach(() => {
    if (originalBucket !== undefined) {
      process.env.SESSION_BUCKET = originalBucket;
    } else {
      delete process.env.SESSION_BUCKET;
    }
    if (originalAiProvider !== undefined) {
      process.env.AI_PROVIDER = originalAiProvider;
    } else {
      delete process.env.AI_PROVIDER;
    }
    if (originalAiModel !== undefined) {
      process.env.AI_MODEL = originalAiModel;
    } else {
      delete process.env.AI_MODEL;
    }
    if (originalAwsRegion !== undefined) {
      process.env.AWS_REGION = originalAwsRegion;
    } else {
      delete process.env.AWS_REGION;
    }
    if (originalBedrockRegion !== undefined) {
      process.env.BEDROCK_REGION = originalBedrockRegion;
    } else {
      delete process.env.BEDROCK_REGION;
    }
  });

  async function loadHandler() {
    const mod = await import("../src/handler.js");
    return mod.handler;
  }

  function createEvent(overrides: Partial<LambdaAgentEvent> = {}): LambdaAgentEvent {
    return {
      userId: "user-123",
      sessionId: "session-456",
      message: "Hello",
      channel: "web",
      ...overrides,
    };
  }

  it("should return error when SESSION_BUCKET is not set", async () => {
    delete process.env.SESSION_BUCKET;
    const handler = await loadHandler();
    const result = (await handler(createEvent())) as LambdaAgentResponse;

    expect(result.success).toBe(false);
    expect(result.error).toContain("SESSION_BUCKET");
  });

  it("should resolve secrets on first invocation", async () => {
    const handler = await loadHandler();
    await handler(createEvent());

    expect(mockResolveSecrets).toHaveBeenCalled();
  });

  it("should initialize config with resolved API key", async () => {
    const handler = await loadHandler();
    await handler(createEvent());

    expect(mockInitConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        anthropicApiKey: "test-api-key",
      }),
    );
  });

  it("should download session from S3", async () => {
    const handler = await loadHandler();
    await handler(createEvent());

    expect(mockDownload).toHaveBeenCalledWith("user-123", "session-456");
  });

  it("should call agent runner with correct params", async () => {
    const handler = await loadHandler();
    await handler(createEvent({ message: "What is 2+2?" }));

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-456",
        message: "What is 2+2?",
        channel: "web",
      }),
    );
  });

  it("should upload session to S3 after agent run", async () => {
    const handler = await loadHandler();
    await handler(createEvent());

    expect(mockUpload).toHaveBeenCalledWith("user-123", "session-456");
  });

  it("should return agent response", async () => {
    const handler = await loadHandler();
    const result = (await handler(createEvent())) as LambdaAgentResponse;

    expect(result.success).toBe(true);
    expect(result.payloads).toEqual([{ text: "Hello from agent!" }]);
  });

  it("should upload session even when agent errors", async () => {
    mockRunAgent.mockRejectedValueOnce(new Error("Agent failed"));

    const handler = await loadHandler();
    const result = (await handler(createEvent())) as LambdaAgentResponse;

    expect(result.success).toBe(false);
    expect(result.error).toBe("Agent failed");
    expect(mockUpload).toHaveBeenCalledWith("user-123", "session-456");
  });

  it("should pass model override when provided", async () => {
    const handler = await loadHandler();
    await handler(createEvent({ model: "claude-opus-4-20250514" }));

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-opus-4-20250514",
      }),
    );
  });

  it("should pass disableTools flag", async () => {
    const handler = await loadHandler();
    await handler(createEvent({ disableTools: true }));

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        disableTools: true,
      }),
    );
  });
});
