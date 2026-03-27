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

    const written = JSON.parse(
      mockedFs.writeFileSync.mock.calls[0][1] as string,
    );
    expect(written.gateway.port).toBe(18789);
  });

  it("should remove auth token", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json");

    const written = JSON.parse(
      mockedFs.writeFileSync.mock.calls[0][1] as string,
    );
    expect(written.auth.token).toBeUndefined();
  });

  it("should remove secrets (token, apiKey, botToken)", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json");

    const written = JSON.parse(
      mockedFs.writeFileSync.mock.calls[0][1] as string,
    );
    expect(written.auth.token).toBeUndefined();
    expect(written.llm).toBeUndefined();
    expect(written.telegram).toBeUndefined();
  });

  it("should override LLM model from env var", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json", { llmModel: "claude-sonnet" });

    const written = JSON.parse(
      mockedFs.writeFileSync.mock.calls[0][1] as string,
    );
    expect(written.agents.defaults.model.primary).toBe("anthropic/claude-sonnet");
  });

  it("should not set agents.defaults.model when no provider or model provided", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json");

    const written = JSON.parse(
      mockedFs.writeFileSync.mock.calls[0][1] as string,
    );
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

    const written = JSON.parse(
      mockedFs.writeFileSync.mock.calls[0][1] as string,
    );
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

    const written = JSON.parse(
      mockedFs.writeFileSync.mock.calls[0][1] as string,
    );
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

    const written = JSON.parse(
      mockedFs.writeFileSync.mock.calls[0][1] as string,
    );
    expect(written.skills).toEqual(configWithSkills.skills);
  });

  it("should preserve agents configuration from existing config", () => {
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

    const written = JSON.parse(
      mockedFs.writeFileSync.mock.calls[0][1] as string,
    );
    expect(written.agents).toEqual(configWithAgents.agents);
  });

  it("should preserve gateway.host while overriding gateway.port", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json");

    const written = JSON.parse(
      mockedFs.writeFileSync.mock.calls[0][1] as string,
    );
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

    const written = JSON.parse(
      mockedFs.writeFileSync.mock.calls[0][1] as string,
    );
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

    const written = JSON.parse(
      mockedFs.writeFileSync.mock.calls[0][1] as string,
    );
    expect(written.customSection).toEqual({ foo: "bar" });
    expect(written.anotherSection).toEqual([1, 2, 3]);
  });

  it("should set workspace path when provided", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json", { workspacePath: "/data/workspace" });

    const written = JSON.parse(
      mockedFs.writeFileSync.mock.calls[0][1] as string,
    );
    expect(written.agents.defaults.workspace).toBe("/data/workspace");
  });

  it("should disable bedrockDiscovery even when aiProvider is bedrock", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json", {
      aiProvider: "bedrock",
      awsRegion: "us-east-1",
    });

    const written = JSON.parse(
      mockedFs.writeFileSync.mock.calls[0][1] as string,
    );
    expect(written.models.bedrockDiscovery.enabled).toBe(false);
    expect(written.agents.defaults.model.primary).toMatch(/^amazon-bedrock[/]/);
  });
});

describe("MCP server auto-configuration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should inject brave-search when BRAVE_API_KEY is set", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json", { mcpEnv: { BRAVE_API_KEY: "test-key" } });

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.mcpServers["brave-search"]).toMatchObject({
      command: "npx",
      env: { BRAVE_API_KEY: "test-key" },
    });
  });

  it("should inject github when GITHUB_TOKEN is set", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json", { mcpEnv: { GITHUB_TOKEN: "ghp_test" } });

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.mcpServers["github"]).toMatchObject({
      command: "npx",
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_test" },
    });
  });

  it("should not overwrite user-configured MCP server", () => {
    const config = { ...BASE_CONFIG, mcpServers: { "brave-search": { command: "custom" } } };
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(config));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json", { mcpEnv: { BRAVE_API_KEY: "should-not-override" } });

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.mcpServers["brave-search"].command).toBe("custom");
  });

  it("should not inject servers when env vars are absent", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json", { mcpEnv: {} });

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.mcpServers?.["brave-search"]).toBeUndefined();
  });

  it("should not inject server when env var is empty string", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json", { mcpEnv: { BRAVE_API_KEY: "" } });

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.mcpServers?.["brave-search"]).toBeUndefined();
  });

  it("should merge auto-configured servers with user-configured ones", () => {
    const config = { ...BASE_CONFIG, mcpServers: { trello: { command: "npx" } } };
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(config));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json", { mcpEnv: { BRAVE_API_KEY: "brave-key" } });

    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.mcpServers["trello"]).toBeDefined();
    expect(written.mcpServers["brave-search"]).toBeDefined();
  });
});
