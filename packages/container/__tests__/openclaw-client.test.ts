import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenClawClient } from "../src/openclaw-client.js";

vi.mock("ws", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("node:events");

  class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_url: string) {
      super();
      queueMicrotask(() => this.emit("open"));
    }
  }

  return {
    default: MockWebSocket,
    WebSocket: MockWebSocket,
  };
});

vi.mock("node:crypto", () => ({
  randomUUID: () => "test-uuid-1234",
}));

/** Simulate gateway connect.challenge then hello-ok after client responds */
function simulateHandshake(client: OpenClawClient): void {
  // Gateway sends connect.challenge
  client.ws?.emit(
    "message",
    JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "test-nonce", ts: 1700000000000 },
    }),
  );
  // Gateway sends hello-ok after receiving connect request
  client.ws?.emit(
    "message",
    JSON.stringify({
      type: "res",
      id: "connect-1",
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: 3,
        snapshot: {
          sessionDefaults: { mainSessionKey: "test-session-key" },
        },
      },
    }),
  );
}

describe("OpenClawClient", () => {
  let client: OpenClawClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new OpenClawClient("ws://localhost:18789", "test-token");
  });

  afterEach(() => {
    client.close();
    vi.useRealTimers();
  });

  it("should connect without token in URL", () => {
    expect(client.gatewayUrl).toBe("ws://localhost:18789");
  });

  it("should respond to connect.challenge with connect request", async () => {
    await vi.advanceTimersByTimeAsync(0);

    // Gateway sends challenge
    client.ws?.emit(
      "message",
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "abc123", ts: 1700000000000 },
      }),
    );

    const sendFn = client.ws?.send as ReturnType<typeof vi.fn>;
    expect(sendFn).toHaveBeenCalledTimes(1);
    const connectMsg = JSON.parse(sendFn.mock.calls[0][0] as string);
    expect(connectMsg.type).toBe("req");
    expect(connectMsg.id).toBe("connect-1");
    expect(connectMsg.method).toBe("connect");
    expect(connectMsg.params.client.id).toBe("gateway-client");
    expect(connectMsg.params.client.mode).toBe("backend");
    expect(connectMsg.params.role).toBe("operator");
    expect(connectMsg.params.auth.token).toBe("test-token");
    expect(connectMsg.params.minProtocol).toBe(3);
    expect(connectMsg.params.device).toBeUndefined();
  });

  it("should resolve waitForReady on hello-ok", async () => {
    await vi.advanceTimersByTimeAsync(0);
    simulateHandshake(client);
    await expect(client.waitForReady()).resolves.toBeUndefined();
  });

  it("should send chat.send request via sendMessage after handshake", async () => {
    await vi.advanceTimersByTimeAsync(0);
    simulateHandshake(client);
    await client.waitForReady();

    const generator = client.sendMessage("user-1", "Hello");
    const resultPromise = generator.next();

    await vi.advanceTimersByTimeAsync(0);

    const sendFn = client.ws?.send as ReturnType<typeof vi.fn>;
    // call[0] is connect request, call[1] is chat.send
    expect(sendFn).toHaveBeenCalledTimes(2);
    const sentMsg = JSON.parse(sendFn.mock.calls[1][0] as string);
    expect(sentMsg.type).toBe("req");
    expect(sentMsg.method).toBe("chat.send");
    expect(sentMsg.params.sessionKey).toBe("agent:main:main");
    expect(sentMsg.params.message).toBe("Hello");
    expect(sentMsg.params.idempotencyKey).toBe("test-uuid-1234");
    expect(typeof sentMsg.id).toBe("string");

    const reqId = sentMsg.id;

    // Gateway responds with runId
    client.ws?.emit(
      "message",
      JSON.stringify({
        type: "res",
        id: reqId,
        ok: true,
        payload: { runId: "run-abc" },
      }),
    );

    await vi.advanceTimersByTimeAsync(0);

    // Gateway streams agent events (cumulative text in "data" field)
    client.ws?.emit(
      "message",
      JSON.stringify({
        type: "event",
        event: "agent",
        payload: { runId: "run-abc", stream: "assistant", seq: 1, data: "Hello " },
      }),
    );

    const chunk1 = await resultPromise;
    expect(chunk1.value).toBe("Hello ");
    expect(chunk1.done).toBe(false);

    const chunk2Promise = generator.next();
    client.ws?.emit(
      "message",
      JSON.stringify({
        type: "event",
        event: "agent",
        // Cumulative: full text "Hello world!" — only delta "world!" is yielded
        payload: { runId: "run-abc", stream: "assistant", seq: 2, data: "Hello world!" },
      }),
    );

    const chunk2 = await chunk2Promise;
    expect(chunk2.value).toBe("world!");

    const endPromise = generator.next();
    client.ws?.emit(
      "message",
      JSON.stringify({
        type: "event",
        event: "chat",
        payload: { runId: "run-abc", state: "final", seq: 3 },
      }),
    );

    const end = await endPromise;
    expect(end.done).toBe(true);
  });

  it("should handle chat error events", async () => {
    await vi.advanceTimersByTimeAsync(0);
    simulateHandshake(client);
    await client.waitForReady();

    const generator = client.sendMessage("user-1", "Hello");
    const resultPromise = generator.next();
    await vi.advanceTimersByTimeAsync(0);

    const sendFn = client.ws?.send as ReturnType<typeof vi.fn>;
    const sentMsg = JSON.parse(sendFn.mock.calls[1][0] as string);

    // Gateway responds with runId
    client.ws?.emit(
      "message",
      JSON.stringify({
        type: "res",
        id: sentMsg.id,
        ok: true,
        payload: { runId: "run-err" },
      }),
    );

    await vi.advanceTimersByTimeAsync(0);

    // Gateway sends error event
    client.ws?.emit(
      "message",
      JSON.stringify({
        type: "event",
        event: "chat",
        payload: {
          runId: "run-err",
          state: "error",
          seq: 1,
          errorMessage: "Model error",
        },
      }),
    );

    await expect(resultPromise).rejects.toThrow("Model error");
  });

  it("should handle chat.send request failure", async () => {
    await vi.advanceTimersByTimeAsync(0);
    simulateHandshake(client);
    await client.waitForReady();

    const generator = client.sendMessage("user-1", "Hello");
    const resultPromise = generator.next();
    await vi.advanceTimersByTimeAsync(0);

    const sendFn = client.ws?.send as ReturnType<typeof vi.fn>;
    const sentMsg = JSON.parse(sendFn.mock.calls[1][0] as string);

    // Gateway rejects chat.send
    client.ws?.emit(
      "message",
      JSON.stringify({
        type: "res",
        id: sentMsg.id,
        ok: false,
        error: { code: "INVALID_REQUEST", message: "Invalid session" },
      }),
    );

    await expect(resultPromise).rejects.toThrow("Invalid session");
  });

  it("should reject waitForReady on connect error response", async () => {
    await vi.advanceTimersByTimeAsync(0);
    client.ws?.emit(
      "message",
      JSON.stringify({
        type: "res",
        id: "connect-1",
        ok: false,
        error: { code: "AUTH_FAILED", message: "bad token" },
      }),
    );
    await expect(client.waitForReady()).rejects.toThrow("bad token");
  });

  it("should close the WebSocket connection", async () => {
    await vi.advanceTimersByTimeAsync(0);
    client.close();
    expect(client.ws?.close).toHaveBeenCalled();
  });
});
