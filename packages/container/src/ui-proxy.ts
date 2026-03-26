import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import httpProxy from "http-proxy";
import { validateUiToken } from "@serverless-openclaw/shared";

export interface UiProxyDeps {
  bridgeAuthToken: string;
  lifecycle: {
    updateLastActivity(): void;
  };
  targetPort: number;
}

export interface UiProxyServer {
  server: ReturnType<typeof createServer>;
  listen(port: number, host: string): Promise<void>;
  close(): Promise<void>;
}

const COOKIE_NAME = "ui_session";
const COOKIE_MAX_AGE_SEC = 86400;
const COOKIE_MAX_AGE_MS = COOKIE_MAX_AGE_SEC * 1000;

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function signExpiry(secret: Buffer, expiry: string): string {
  return createHmac("sha256", secret).update(expiry).digest("hex");
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    cookies[key] = value;
  }
  return cookies;
}

export function createUiProxy(deps: UiProxyDeps): UiProxyServer {
  const cookieSecret = randomBytes(32);
  const usedTokens = new Set<string>();

  const proxy = httpProxy.createProxyServer({
    target: `http://localhost:${deps.targetPort}`,
    ws: true,
  });

  proxy.on("error", (err, req, res) => {
    console.error("Proxy error:", err.message);
    if (res && "writeHead" in res && !(res as ServerResponse).headersSent) {
      (res as ServerResponse).writeHead(502);
      (res as ServerResponse).end("Bad Gateway");
    }
  });

  function createCookieValue(): string {
    const expiry = String(Date.now() + COOKIE_MAX_AGE_MS);
    const hmac = signExpiry(cookieSecret, expiry);
    return `${expiry}.${hmac}`;
  }

  function validateCookie(req: IncomingMessage): boolean {
    try {
      const cookies = parseCookies(req.headers.cookie);
      const value = cookies[COOKIE_NAME];
      if (!value) return false;

      const dotIdx = value.indexOf(".");
      if (dotIdx < 0) return false;

      const expiry = value.slice(0, dotIdx);
      const signature = value.slice(dotIdx + 1);

      if (Number(expiry) <= Date.now()) return false;

      const expected = signExpiry(cookieSecret, expiry);
      return safeCompare(signature, expected);
    } catch {
      return false;
    }
  }

  function handleTokenExchange(
    req: IncomingMessage,
    res: ServerResponse,
  ): boolean {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ui") return false;

    const token = url.searchParams.get("token");
    if (!token || !validateUiToken(token, deps.bridgeAuthToken, usedTokens)) {
      res.writeHead(401);
      res.end("Unauthorized");
      return true;
    }

    const cookieValue = createCookieValue();
    res.writeHead(302, {
      Location: "/",
      "Set-Cookie":
        `${COOKIE_NAME}=${cookieValue}; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SEC}; Path=/`,
    });
    res.end();
    deps.lifecycle.updateLastActivity();
    return true;
  }

  const server = createServer((req, res) => {
    if (handleTokenExchange(req, res)) return;

    if (!validateCookie(req)) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }

    deps.lifecycle.updateLastActivity();
    proxy.web(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    if (!validateCookie(req)) {
      socket.destroy();
      return;
    }

    deps.lifecycle.updateLastActivity();
    proxy.ws(req, socket, head);
  });

  return {
    server,
    listen(port: number, host: string): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
