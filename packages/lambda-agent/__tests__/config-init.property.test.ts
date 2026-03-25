import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initConfig } from "../src/config-init.js";

/**
 * Property-based tests for config-init Bedrock support.
 * Uses fast-check to verify universal properties across generated inputs.
 */

describe("config-init — property tests", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lambda-agent-pbt-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Property 5: Bedrock region config round-trip
   * For any non-empty region string, calling initConfig with provider "bedrock"
   * and that region, then reading back openclaw.json, yields
   * models.bedrockDiscovery.region equal to the input and enabled === true.
   *
   * Validates: Requirements 3.1, 6.1, 6.3
   */
  it("Property 5: Bedrock region config round-trip", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        async (region) => {
          // Each iteration needs a fresh temp dir since initConfig overwrites
          const iterDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "lambda-agent-pbt-iter-"),
          );
          process.env.HOME = iterDir;

          try {
            await initConfig({ provider: "bedrock", bedrockRegion: region });

            const configPath = path.join(iterDir, ".openclaw", "openclaw.json");
            const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            const discovery = config.models.bedrockDiscovery;

            expect(discovery.enabled).toBe(true);
            expect(discovery.region).toBe(region);
          } finally {
            fs.rmSync(iterDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
