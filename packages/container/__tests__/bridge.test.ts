import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/bridge.js";
import type { BridgeDeps } from "../src/bridge.js";

vi.mock("../src/metrics.js", () => ({
  publishMessageMetrics: vi.fn().mockResolvedValue(undefined),
  publishFirstResponseTime: vi.fn().mockResolvedValue(undefined),
}));

function createMockDeps(): BridgeDeps {
  return {
    authToken: "test-secret-token",
    openclawClient: {
      sendMessage: vi.fn(async function* () {
        yield "Hello ";
        yield "world!";
      }),
      close: vi.fn(),
      connected: true,
    },
    callbackSender: {
      send: vi.fn().mockResolvedValue(undefined),
    },
    lifecycle: {
      updateTaskState: vi.fn().mockResolvedValue(undefined),
      gracefulShutdown: vi.fn().mockResolvedValue(undefined),
      updateLastActivity: vi.fn(),
      lastActivityTime: new Date(),
    },
    processStartTime: Date.now(),
    channel: "web",
  };
}

describe("Bridge HTTP Server", () => {
  let deps: BridgeDeps;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createApp(deps);
  });

  describe("GET /health", () => {
    it("should return 200 without auth", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok" });
    });
  });

  describe("POST /message", () => {
    it("should return 202 with valid token and body", async () => {
      const res = await request(app)
        .post("/message")
        .set("Authorization", "Bearer test-secret-token")
        .send({
          userId: "user-1",
          message: "Hello",
          channel: "web",
          connectionId: "conn-123",
          callbackUrl: "https://example.com/prod",
        });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ status: "processing" });
    });

    it("should return 401 without token", async () => {
      const res = await request(app).post("/message").send({
        userId: "user-1",
        message: "Hello",
        channel: "web",
        connectionId: "conn-123",
        callbackUrl: "https://example.com/prod",
      });

      expect(res.status).toBe(401);
    });

    it("should return 400 with missing required fields", async () => {
      const res = await request(app)
        .post("/message")
        .set("Authorization", "Bearer test-secret-token")
        .send({ userId: "user-1" }); // missing message, channel, etc.

      expect(res.status).toBe(400);
    });

    it("should call openclawClient.sendMessage asynchronously", async () => {
      const res = await request(app)
        .post("/message")
        .set("Authorization", "Bearer test-secret-token")
        .send({
          userId: "user-1",
          message: "Hello",
          channel: "web",
          connectionId: "conn-123",
          callbackUrl: "https://example.com/prod",
        });

      expect(res.status).toBe(202);

      // Wait for async processing to complete
      await vi.waitFor(() => {
        expect(deps.openclawClient.sendMessage).toHaveBeenCalledWith("user-1", "Hello");
      });
    });

    it("should update lastActivity on message", async () => {
      await request(app).post("/message").set("Authorization", "Bearer test-secret-token").send({
        userId: "user-1",
        message: "Hello",
        channel: "web",
        connectionId: "conn-123",
        callbackUrl: "https://example.com/prod",
      });

      expect(deps.lifecycle.updateLastActivity).toHaveBeenCalled();
    });
  });

  describe("GET /status", () => {
    it("should return 200 with status info", async () => {
      const res = await request(app)
        .get("/status")
        .set("Authorization", "Bearer test-secret-token");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("status", "running");
      expect(res.body).toHaveProperty("uptime");
      expect(res.body).toHaveProperty("lastActivity");
    });

    it("should return 401 without token", async () => {
      const res = await request(app).get("/status");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /shutdown", () => {
    it("should return 200 and call gracefulShutdown", async () => {
      const res = await request(app)
        .post("/shutdown")
        .set("Authorization", "Bearer test-secret-token");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "shutting_down" });

      await new Promise((r) => setTimeout(r, 50));
      expect(deps.lifecycle.gracefulShutdown).toHaveBeenCalled();
    });

    it("should return 401 without token", async () => {
      const res = await request(app).post("/shutdown");
      expect(res.status).toBe(401);
    });
  });
});
