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
    expect(written.llm.apiKey).toBeUndefined();
    expect(written.telegram).toBeUndefined();
  });

  it("should override LLM model from env var", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json", { llmModel: "claude-sonnet" });

    const written = JSON.parse(
      mockedFs.writeFileSync.mock.calls[0][1] as string,
    );
    expect(written.llm.model).toBe("claude-sonnet");
  });

  it("should keep LLM model unchanged when no override provided", () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
    mockedFs.writeFileSync.mockImplementation(() => {});

    patchConfig("/path/to/openclaw.json");

    const written = JSON.parse(
      mockedFs.writeFileSync.mock.calls[0][1] as string,
    );
    expect(written.llm.model).toBe("gpt-4");
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

  describe("Bedrock provider support", () => {
    it("should set bedrockDiscovery.enabled to true and remove llm.apiKey when provider is bedrock", () => {
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
      mockedFs.writeFileSync.mockImplementation(() => {});

      patchConfig("/path/to/openclaw.json", { provider: "bedrock" });

      const written = JSON.parse(
        mockedFs.writeFileSync.mock.calls[0][1] as string,
      );
      expect(written.models.bedrockDiscovery.enabled).toBe(true);
      expect(written.llm.apiKey).toBeUndefined();
    });

    it("should not set bedrockDiscovery when provider is anthropic", () => {
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
      mockedFs.writeFileSync.mockImplementation(() => {});

      patchConfig("/path/to/openclaw.json", { provider: "anthropic" });

      const written = JSON.parse(
        mockedFs.writeFileSync.mock.calls[0][1] as string,
      );
      expect(written.models).toBeUndefined();
    });

    it("should not set bedrockDiscovery when provider is not specified", () => {
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(BASE_CONFIG));
      mockedFs.writeFileSync.mockImplementation(() => {});

      patchConfig("/path/to/openclaw.json");

      const written = JSON.parse(
        mockedFs.writeFileSync.mock.calls[0][1] as string,
      );
      expect(written.models).toBeUndefined();
    });

    it("should preserve existing models config when adding bedrockDiscovery", () => {
      const configWithModels = {
        ...BASE_CONFIG,
        models: { someOtherSetting: "value" },
      };
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(configWithModels));
      mockedFs.writeFileSync.mockImplementation(() => {});

      patchConfig("/path/to/openclaw.json", { provider: "bedrock" });

      const written = JSON.parse(
        mockedFs.writeFileSync.mock.calls[0][1] as string,
      );
      expect(written.models.bedrockDiscovery.enabled).toBe(true);
      expect(written.models.someOtherSetting).toBe("value");
    });
  });
});
