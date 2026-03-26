import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createUiProxy } from "../src/ui-proxy.js";
import { generateUiToken } from "@serverless-openclaw/shared";

const BRIDGE_TOKEN = "test-bridge-auth-token-32bytes!!";

function makeLifecycle() {
  return { updateLastActivity: vi.fn() };
}

function makeReq(url: string, cookie?: string): Partial<IncomingMessage> {
  return {
    url,
    headers: {
      host: "localhost",
      ...(cookie ? { cookie } : {}),
    },
  };
}

function makeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 0;
  let body = "";
  const res = {
    writeHead: vi.fn((code: number, hdrs?: Record<string, string>) => {
      statusCode = code;
      if (hdrs) Object.assign(headers, hdrs);
    }),
    end: vi.fn((data?: string) => {
      if (data) body = data;
    }),
    headersSent: false,
    getStatusCode: () => statusCode,
    getHeaders: () => headers,
    getBody: () => body,
  };
  return res as unknown as ServerResponse & {
    getStatusCode(): number;
    getHeaders(): Record<string, string>;
    getBody(): string;
  };
}

describe("ui-proxy token exchange", () => {
  it("should issue a cookie and redirect when token is valid", () => {
    const lifecycle = makeLifecycle();
    const proxy = createUiProxy({ bridgeAuthToken: BRIDGE_TOKEN, lifecycle, targetPort: 18789 });

    const token = generateUiToken(BRIDGE_TOKEN);
    const req = makeReq(`/ui?token=${token}`);
    const res = makeRes();

    // Simulate a request — access internal handler via server event
    proxy.server.emit("request", req, res);

    expect(res.getStatusCode()).toBe(302);
    expect(res.getHeaders()["Location"]).toBe("/");
    const cookie = res.getHeaders()["Set-Cookie"];
    expect(cookie).toMatch(/^ui_session=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(lifecycle.updateLastActivity).toHaveBeenCalledOnce();
  });

  it("should reject an invalid token with 401", () => {
    const lifecycle = makeLifecycle();
    const proxy = createUiProxy({ bridgeAuthToken: BRIDGE_TOKEN, lifecycle, targetPort: 18789 });

    const req = makeReq("/ui?token=bad-token");
    const res = makeRes();

    proxy.server.emit("request", req, res);

    expect(res.getStatusCode()).toBe(401);
    expect(lifecycle.updateLastActivity).not.toHaveBeenCalled();
  });

  it("should reject a reused token (single-use)", () => {
    const lifecycle = makeLifecycle();
    const proxy = createUiProxy({ bridgeAuthToken: BRIDGE_TOKEN, lifecycle, targetPort: 18789 });

    const token = generateUiToken(BRIDGE_TOKEN);
    const req1 = makeReq(`/ui?token=${token}`);
    const req2 = makeReq(`/ui?token=${token}`);
    const res1 = makeRes();
    const res2 = makeRes();

    proxy.server.emit("request", req1, res1);
    proxy.server.emit("request", req2, res2);

    expect(res1.getStatusCode()).toBe(302);
    expect(res2.getStatusCode()).toBe(401);
  });

  it("should reject a request without cookie with 401", () => {
    const lifecycle = makeLifecycle();
    const proxy = createUiProxy({ bridgeAuthToken: BRIDGE_TOKEN, lifecycle, targetPort: 18789 });

    const req = makeReq("/");
    const res = makeRes();

    proxy.server.emit("request", req, res);

    expect(res.getStatusCode()).toBe(401);
    expect(res.getBody()).toBe("Unauthorized");
  });
});
