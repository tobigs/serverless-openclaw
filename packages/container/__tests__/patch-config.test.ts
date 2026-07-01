import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import { patchConfig } from "../src/patch-config.js";

vi.mock("node:fs");

const mockedFs = vi.mocked(fs);

const BASE_CONFIG = {
  gateway: { port: 9999, host: "0.0.0.0" },
  auth: { method: "token", token: "secret-token" },
  telegram: { enabled: true, botToken: "tg-token" },
  llm: { model: "gpt-4", apiKey: "sk-secret" },
  workspace: "/data/workspace",
};

describe("patchConfig", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should set gateway port to 18789", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json");

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.gateway.port).toBe(18789);
  });

  it("should remove auth token", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json");

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.auth.token).toBeUndefined();
  });

  it("should remove secrets (token, apiKey, botToken)", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json");

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.auth.token).toBeUndefined();
    expect(written.llm).toBeUndefined();
    expect(written.telegram).toBeUndefined();
  });

  it("should override LLM model from env var", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json", { llmModel: "claude-sonnet" });

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.agents.defaults.model.primary).toBe("anthropic/claude-sonnet");
  });

  it("should not set agents.defaults.model when no provider or model provided", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json");

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.llm).toBeUndefined();
    expect(written.agents?.defaults?.model).toBeUndefined();
  });

  it("should read from and write to the correct path", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/home/openclaw/.openclaw/openclaw.json");

    expect(mockedFs.readFileSync).toHaveBeenCalledWith(
      "/home/openclaw/.openclaw/openclaw.json",
      "utf-8",
    );
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      "/home/openclaw/.openclaw/openclaw.json",
      expect.any(String),
      "utf-8",
    );
  });

  it("should handle config without optional sections", () => {
    const minimal = { gateway: { port: 9999 } };
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(minimal));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json");

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.gateway.port).toBe(18789);
  });

  // --- New tests: preserve user-owned config keys ---

  it("should preserve mcpServers from existing config", () => {
    const configWithMcp = {
      ...BASE_CONFIG,
      mcpServers: {
        trello: {
          command: "npx",
          args: ["-y", "trello-mcp-server"],
          env: { TRELLO_API_KEY: "key123" },
        },
      },
    };
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(configWithMcp));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json");

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.mcpServers).toEqual(configWithMcp.mcpServers);
  });

  it("should preserve skills configuration from existing config", () => {
    const configWithSkills = {
      ...BASE_CONFIG,
      skills: {
        enabled: ["trello-mcp", "calendar"],
        disabled: ["browser"],
      },
    };
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(configWithSkills));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json");

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.skills).toEqual(configWithSkills.skills);
  });

  it("should preserve agents configuration from existing config", () => {
    delete process.env.THINKING_LEVEL;
    const configWithAgents = {
      ...BASE_CONFIG,
      agents: {
        defaults: {
          workspace: "/data/workspace",
          model: "anthropic/claude-sonnet-4-20250514",
        },
      },
    };
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(configWithAgents));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json");

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.agents).toEqual({
      defaults: {
        workspace: "/data/workspace",
        model: "anthropic/claude-sonnet-4-20250514",
        thinkingDefault: "default",
      },
    });
  });

  it("should preserve gateway.host while overriding gateway.port", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json");

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.gateway.port).toBe(18789);
    expect(written.gateway.host).toBe("0.0.0.0");
  });

  it("should preserve gateway.controlUi settings", () => {
    const configWithControlUi = {
      ...BASE_CONFIG,
      gateway: {
        ...BASE_CONFIG.gateway,
        controlUi: { dangerouslyDisableDeviceAuth: true },
      },
    };
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(configWithControlUi));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json");

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.gateway.controlUi).toEqual({
      dangerouslyDisableDeviceAuth: true,
    });
  });

  it("should preserve unknown top-level keys (future-proof)", () => {
    const configWithUnknown = {
      ...BASE_CONFIG,
      customSection: { foo: "bar" },
      anotherSection: [1, 2, 3],
    };
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(configWithUnknown));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json");

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.customSection).toEqual({ foo: "bar" });
    expect(written.anotherSection).toEqual([1, 2, 3]);
  });

  it("should set workspace path when provided", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json", { workspacePath: "/data/workspace" });

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.agents.defaults.workspace).toBe("/data/workspace");
  });

  it("should seed bedrock model from env on first boot (no persisted model)", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json", {
      aiProvider: "bedrock",
      awsRegion: "us-east-1",
    });

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.agents.defaults.model.primary).toMatch(/^amazon-bedrock[/]/);
    // Provider model must be explicitly registered so OpenClaw doesn't need async discovery
    expect(written.models.providers["amazon-bedrock"].baseUrl).toContain("us-east-1");
    expect(written.models.providers["amazon-bedrock"].models[0].id).toMatch(/^us\.anthropic/);
  });

  it("should keep persisted model when already set (e.g. changed via /model)", () => {
    const configWithPersistedModel = {
      ...BASE_CONFIG,
      agents: {
        defaults: {
          model: { primary: "amazon-bedrock/eu.anthropic.claude-opus-4-8" },
        },
      },
    };
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(configWithPersistedModel));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json", {
      aiProvider: "bedrock",
      awsRegion: "eu-central-1",
    });

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    // Persisted model survives — env seed does not overwrite
    expect(written.agents.defaults.model.primary).toBe(
      "amazon-bedrock/eu.anthropic.claude-opus-4-8",
    );
    // Provider entry uses the persisted model ID
    expect(written.models.providers["amazon-bedrock"].models[0].id).toBe(
      "eu.anthropic.claude-opus-4-8",
    );
  });

  it("should always set thinkingDefault to 'default' — no env override, no forcing", () => {
    const configWithThinking = {
      ...BASE_CONFIG,
      agents: { defaults: { thinkingDefault: "xhigh" } },
    };
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(configWithThinking));
    mockedFs.writeFileSync.mockImplementation(() => {});
    // Even if THINKING_LEVEL happens to be set in the environment, it must be ignored.
    process.env.THINKING_LEVEL = "low";

    patchConfig("/path/to/openclaw.json");

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.agents.defaults.thinkingDefault).toBe("default");
    delete process.env.THINKING_LEVEL;
  });

  it("should seed DeepSeek V3.2 as the active model on first boot in eu-north-1", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json", {
      aiProvider: "bedrock",
      llmModel: "deepseek.v3.2",
      awsRegion: "eu-north-1",
    });

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.agents.defaults.model.primary).toBe("amazon-bedrock/deepseek.v3.2");
    const catalog = written.models.providers["amazon-bedrock"].models;
    expect(catalog[0].id).toBe("deepseek.v3.2");
    // Kimi and GLM are registered as switchable alternates
    expect(catalog.some((m: { id: string }) => m.id === "moonshotai.kimi-k2.5")).toBe(true);
    expect(catalog.some((m: { id: string }) => m.id === "zai.glm-4.7")).toBe(true);
  });

  it("should not force thinking params on any model — catalog registration only, no thinking overrides", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json", {
      aiProvider: "bedrock",
      llmModel: "deepseek.v3.2",
      awsRegion: "eu-north-1",
    });

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.agents.defaults.models).toBeUndefined();
    expect(written.agents.defaults.thinkingDefault).toBe("default");
  });

  it("should target bedrockRegion for the Bedrock endpoint while infra stays in awsRegion", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json", {
      aiProvider: "bedrock",
      llmModel: "deepseek.v3.2",
      awsRegion: "eu-central-1", // infra stays here
      bedrockRegion: "eu-north-1", // only Bedrock calls go here
    });

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.models.providers["amazon-bedrock"].baseUrl).toBe(
      "https://bedrock-runtime.eu-north-1.amazonaws.com",
    );
  });

  it("should fall back to awsRegion for the Bedrock endpoint when bedrockRegion is unset", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json", {
      aiProvider: "bedrock",
      awsRegion: "eu-central-1",
    });

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.models.providers["amazon-bedrock"].baseUrl).toBe(
      "https://bedrock-runtime.eu-central-1.amazonaws.com",
    );
  });

  it("should register Claude Sonnet 5 (global inference) as a catalog alternate", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json", {
      aiProvider: "bedrock",
      awsRegion: "eu-central-1",
    });

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    const catalog = written.models.providers["amazon-bedrock"].models;
    expect(catalog.some((m: { id: string }) => m.id === "global.anthropic.claude-sonnet-5")).toBe(
      true,
    );
    // No per-model thinking overrides are forced — OpenClaw's own defaults apply
    expect(written.agents.defaults.models).toBeUndefined();
  });

  it("should allow Claude Sonnet 5 to be seeded directly as the active model via AI_MODEL", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json", {
      aiProvider: "bedrock",
      llmModel: "global.anthropic.claude-sonnet-5",
      awsRegion: "eu-central-1",
    });

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.agents.defaults.model.primary).toBe(
      "amazon-bedrock/global.anthropic.claude-sonnet-5",
    );
    expect(written.models.providers["amazon-bedrock"].models[0].id).toBe(
      "global.anthropic.claude-sonnet-5",
    );
  });
});
