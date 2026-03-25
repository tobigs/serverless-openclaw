import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initConfig } from "../src/config-init.js";

describe("config-init", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lambda-agent-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should create .openclaw directory structure", async () => {
    await initConfig();

    const openclawDir = path.join(tmpDir, ".openclaw");
    expect(fs.existsSync(openclawDir)).toBe(true);
  });

  it("should create openclaw.json with minimal config", async () => {
    await initConfig();

    const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
    expect(fs.existsSync(configPath)).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.gateway).toEqual({ mode: "local" });
  });

  it("should create agents/default/sessions directory", async () => {
    await initConfig();

    const sessionsDir = path.join(
      tmpDir,
      ".openclaw",
      "agents",
      "default",
      "sessions",
    );
    expect(fs.existsSync(sessionsDir)).toBe(true);
  });

  it("should set ANTHROPIC_API_KEY env var when provided", async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    try {
      await initConfig({ anthropicApiKey: "test-key-123" });
      expect(process.env.ANTHROPIC_API_KEY).toBe("test-key-123");
    } finally {
      if (originalKey) {
        process.env.ANTHROPIC_API_KEY = originalKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it("should not overwrite ANTHROPIC_API_KEY if not provided", async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    try {
      process.env.ANTHROPIC_API_KEY = "existing-key";
      await initConfig();
      expect(process.env.ANTHROPIC_API_KEY).toBe("existing-key");
    } finally {
      if (originalKey) {
        process.env.ANTHROPIC_API_KEY = originalKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it("should be idempotent (safe to call multiple times)", async () => {
    await initConfig();
    await initConfig();

    const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.gateway.mode).toBe("local");
  });

  it("should return the config directory path", async () => {
    const result = await initConfig();
    expect(result.configDir).toBe(path.join(tmpDir, ".openclaw"));
    expect(result.sessionsDir).toBe(
      path.join(tmpDir, ".openclaw", "agents", "default", "sessions"),
    );
  });

  describe("Bedrock provider support", () => {
    function readConfig(): Record<string, unknown> {
      const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
      return JSON.parse(fs.readFileSync(configPath, "utf-8"));
    }

    it("should write bedrockDiscovery.enabled: true for bedrock provider", async () => {
      await initConfig({ provider: "bedrock" });

      const config = readConfig();
      const models = config.models as Record<string, unknown>;
      const discovery = models.bedrockDiscovery as Record<string, unknown>;
      expect(discovery.enabled).toBe(true);
    });

    it("should write bedrockDiscovery.enabled: false for anthropic provider", async () => {
      await initConfig({ provider: "anthropic" });

      const config = readConfig();
      const models = config.models as Record<string, unknown>;
      const discovery = models.bedrockDiscovery as Record<string, unknown>;
      expect(discovery.enabled).toBe(false);
    });

    it("should write bedrockDiscovery.region when bedrock provider has region", async () => {
      await initConfig({ provider: "bedrock", bedrockRegion: "us-west-2" });

      const config = readConfig();
      const models = config.models as Record<string, unknown>;
      const discovery = models.bedrockDiscovery as Record<string, unknown>;
      expect(discovery.enabled).toBe(true);
      expect(discovery.region).toBe("us-west-2");
    });

    it("should omit bedrockDiscovery.region when bedrock provider has no region", async () => {
      await initConfig({ provider: "bedrock" });

      const config = readConfig();
      const models = config.models as Record<string, unknown>;
      const discovery = models.bedrockDiscovery as Record<string, unknown>;
      expect(discovery.enabled).toBe(true);
      expect(discovery.region).toBeUndefined();
    });

    it("should not set ANTHROPIC_API_KEY env var for bedrock provider", async () => {
      const originalKey = process.env.ANTHROPIC_API_KEY;
      try {
        delete process.env.ANTHROPIC_API_KEY;
        await initConfig({
          provider: "bedrock",
          anthropicApiKey: "should-not-be-set",
        });
        expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      } finally {
        if (originalKey) {
          process.env.ANTHROPIC_API_KEY = originalKey;
        } else {
          delete process.env.ANTHROPIC_API_KEY;
        }
      }
    });
  });
});
