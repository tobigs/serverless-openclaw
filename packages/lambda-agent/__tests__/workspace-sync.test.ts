import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fc from "fast-check";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import { matchesAllowlist, WorkspaceSync } from "../src/workspace-sync.js";

describe("workspace-sync", () => {
  let tmpDir: string;
  let mockSend: ReturnType<typeof vi.fn>;
  let mockS3: S3Client;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-sync-test-"));
    mockSend = vi.fn();
    mockS3 = { send: mockSend } as unknown as S3Client;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createSync(overrides: Partial<{ maxFileSize: number; maxTotalSize: number }> = {}) {
    return new WorkspaceSync({
      bucket: "test-bucket",
      localPath: tmpDir,
      s3Client: mockS3,
      ...overrides,
    });
  }

  describe("matchesAllowlist", () => {
    it("should match exact file names", () => {
      expect(matchesAllowlist("MEMORY.md", ["MEMORY.md"])).toBe(true);
    });

    it("should match directory wildcard patterns", () => {
      expect(matchesAllowlist("memory/2025-01-15.md", ["memory/**"])).toBe(true);
      expect(matchesAllowlist("memory/sub/file.md", ["memory/**"])).toBe(true);
    });

    it("should reject non-matching paths", () => {
      expect(matchesAllowlist("secret.txt", ["MEMORY.md", "memory/**"])).toBe(false);
    });
  });

  describe("download", () => {
    it("should fetch files from S3 and write to local path with subdirectories", async () => {
      const content = "# Memory\nSome content";
      mockSend
        .mockResolvedValueOnce({
          Contents: [
            { Key: "workspaces/user-123/MEMORY.md", Size: content.length },
            { Key: "workspaces/user-123/memory/2025-01-15.md", Size: content.length },
          ],
          IsTruncated: false,
        })
        .mockResolvedValueOnce({
          Body: {
            transformToByteArray: () => new Uint8Array(Buffer.from(content)),
          },
        })
        .mockResolvedValueOnce({
          Body: {
            transformToByteArray: () => new Uint8Array(Buffer.from(content)),
          },
        });

      const sync = createSync();
      await sync.download("user-123");

      expect(fs.existsSync(path.join(tmpDir, "MEMORY.md"))).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8")).toBe(content);
      expect(fs.existsSync(path.join(tmpDir, "memory", "2025-01-15.md"))).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, "memory", "2025-01-15.md"), "utf-8")).toBe(
        content,
      );
    });

    it("should skip files not matching allowlist", async () => {
      mockSend
        .mockResolvedValueOnce({
          Contents: [
            { Key: "workspaces/user-123/MEMORY.md", Size: 6 },
            { Key: "workspaces/user-123/secret.txt", Size: 6 },
            { Key: "workspaces/user-123/node_modules/pkg.js", Size: 6 },
          ],
          IsTruncated: false,
        })
        .mockResolvedValueOnce({
          Body: {
            transformToByteArray: () => new Uint8Array(Buffer.from("memory")),
          },
        });

      const sync = createSync();
      await sync.download("user-123");

      expect(fs.existsSync(path.join(tmpDir, "MEMORY.md"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "secret.txt"))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, "node_modules", "pkg.js"))).toBe(false);
      // 1 list + 1 get (only MEMORY.md)
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("should skip files exceeding maxFileSize", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      mockSend
        .mockResolvedValueOnce({
          Contents: [
            { Key: "workspaces/user-123/MEMORY.md", Size: 200 },
            { Key: "workspaces/user-123/USER.md", Size: 50 },
          ],
          IsTruncated: false,
        })
        .mockResolvedValueOnce({
          Body: {
            transformToByteArray: () => new Uint8Array(Buffer.from("small")),
          },
        });

      const sync = createSync({ maxFileSize: 100 });
      await sync.download("user-123");

      expect(fs.existsSync(path.join(tmpDir, "MEMORY.md"))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, "USER.md"))).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("exceeds maxFileSize"));
    });

    it("should stop downloading when maxTotalSize exceeded", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      mockSend
        .mockResolvedValueOnce({
          Contents: [
            { Key: "workspaces/user-123/MEMORY.md", Size: 80 },
            { Key: "workspaces/user-123/USER.md", Size: 80 },
          ],
          IsTruncated: false,
        })
        .mockResolvedValueOnce({
          Body: {
            transformToByteArray: () => new Uint8Array(80),
          },
        });

      const sync = createSync({ maxTotalSize: 100 });
      await sync.download("user-123");

      // First file downloaded, second skipped due to total size
      expect(fs.existsSync(path.join(tmpDir, "MEMORY.md"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "USER.md"))).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("maxTotalSize"));
    });

    it("should proceed without error when no S3 objects exist", async () => {
      mockSend.mockResolvedValueOnce({
        Contents: undefined,
        IsTruncated: false,
      });

      const sync = createSync();
      await sync.download("user-123");

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("should log error and proceed on S3 failure (fail-open)", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      mockSend.mockRejectedValueOnce(new Error("AccessDenied"));

      const sync = createSync();
      // Should not throw
      await sync.download("user-123");

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[workspace-sync] download failed"),
        expect.any(Error),
      );
    });

    it("should validate userId with SAFE_ID regex", async () => {
      const sync = createSync();
      await expect(sync.download("../etc/passwd")).rejects.toThrow("Invalid userId");
      await expect(sync.download("")).rejects.toThrow("Invalid userId");
      await expect(sync.download("a".repeat(129))).rejects.toThrow("Invalid userId");
    });
  });

  describe("upload", () => {
    it("should upload matching local files to correct S3 keys", async () => {
      fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "memory content");
      fs.mkdirSync(path.join(tmpDir, "memory"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "memory", "2025-01-15.md"), "daily log");

      mockSend.mockResolvedValue({});

      const sync = createSync();
      await sync.upload("user-123");

      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("should skip files not matching allowlist", async () => {
      fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "memory");
      fs.writeFileSync(path.join(tmpDir, "secret.txt"), "secret");

      mockSend.mockResolvedValue({});

      const sync = createSync();
      await sync.upload("user-123");

      // Only MEMORY.md should be uploaded
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("should skip when localPath does not exist", async () => {
      const sync = new WorkspaceSync({
        bucket: "test-bucket",
        localPath: path.join(tmpDir, "nonexistent"),
        s3Client: mockS3,
      });

      await sync.upload("user-123");

      expect(mockSend).not.toHaveBeenCalled();
    });

    it("should validate userId with SAFE_ID regex", async () => {
      const sync = createSync();
      await expect(sync.upload("../etc/passwd")).rejects.toThrow("Invalid userId");
      await expect(sync.upload("user with spaces")).rejects.toThrow("Invalid userId");
    });
  });

  describe("property tests", () => {
    /**
     * **Validates: Requirements 3.1**
     *
     * Property 1: Allowlist consistency — a file matches the allowlist if and only if
     * it equals a pattern or starts with a directory prefix from a `dir/**` pattern.
     */

    // Generate valid file path segments (no slashes, no empty)
    const pathSegment = fc.stringMatching(/^[a-z0-9._-]{1,20}$/);

    // Generate a relative file path like "dir/file.md" or "file.md"
    const relativePath = fc
      .tuple(fc.array(pathSegment, { minLength: 0, maxLength: 3 }), pathSegment)
      .map(([dirs, file]) => (dirs.length > 0 ? [...dirs, file].join("/") : file));

    // Generate an allowlist pattern: either an exact path or a "dir/**" pattern
    const allowlistPattern = fc.oneof(
      relativePath,
      pathSegment.map((dir) => `${dir}/**`),
    );

    it("should match iff path equals a pattern or starts with a dir/** prefix", () => {
      fc.assert(
        fc.property(
          relativePath,
          fc.array(allowlistPattern, { minLength: 1, maxLength: 10 }),
          (filePath, patterns) => {
            const expected = patterns.some((pattern) => {
              if (pattern.endsWith("/**")) {
                const dir = pattern.slice(0, -3);
                return filePath.startsWith(dir + "/");
              }
              return filePath === pattern;
            });
            expect(matchesAllowlist(filePath, patterns)).toBe(expected);
          },
        ),
        { numRuns: 500 },
      );
    });

    /**
     * **Validates: Requirements 7.1, 7.2, 7.3**
     *
     * Property 2: Round-trip consistency — for any set of workspace files matching
     * the allowlist, downloading from S3 then uploading back produces byte-identical
     * S3 objects.
     */
    it("round-trip: download then upload produces byte-identical S3 objects", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              name: fc.constantFrom(
                "MEMORY.md",
                "AGENTS.md",
                "USER.md",
                "SOUL.md",
                "CLAUDE.md",
                "memory/2025-01-15.md",
                "memory/2025-06-20.md",
              ),
              content: fc.string({ minLength: 0, maxLength: 500 }),
            }),
            { minLength: 1, maxLength: 5 },
          ).map((files) => {
            // Deduplicate by name
            const seen = new Set<string>();
            return files.filter((f) => {
              if (seen.has(f.name)) return false;
              seen.add(f.name);
              return true;
            });
          }),
          async (files) => {
            // In-memory S3 store
            const store = new Map<string, Buffer>();
            const userId = "test-user";
            const prefix = `workspaces/${userId}/`;

            // Pre-populate the store with generated files
            for (const f of files) {
              store.set(`${prefix}${f.name}`, Buffer.from(f.content, "utf-8"));
            }

            // Snapshot the original S3 contents for comparison
            const originalStore = new Map<string, Buffer>();
            for (const [key, val] of store) {
              originalStore.set(key, Buffer.from(val));
            }

            // Build a mock S3Client that operates on the in-memory store
            const uploaded = new Map<string, Buffer>();
            const mockS3Send = vi.fn().mockImplementation((command: unknown) => {
              if (command instanceof ListObjectsV2Command) {
                const contents = Array.from(store.entries()).map(([key, buf]) => ({
                  Key: key,
                  Size: buf.length,
                }));
                return Promise.resolve({ Contents: contents, IsTruncated: false });
              }
              if (command instanceof GetObjectCommand) {
                const key = (command as { input: { Key: string } }).input.Key;
                const buf = store.get(key);
                return Promise.resolve({
                  Body: {
                    transformToByteArray: () => new Uint8Array(buf ?? Buffer.alloc(0)),
                  },
                });
              }
              if (command instanceof PutObjectCommand) {
                const input = (command as { input: { Key: string; Body: Buffer } }).input;
                uploaded.set(input.Key, Buffer.from(input.Body));
                return Promise.resolve({});
              }
              return Promise.resolve({});
            });

            const roundTripS3 = { send: mockS3Send } as unknown as S3Client;

            // Create a fresh temp directory for this property run
            const rtTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-rt-"));
            try {
              const sync = new WorkspaceSync({
                bucket: "test-bucket",
                localPath: rtTmpDir,
                s3Client: roundTripS3,
              });

              // Download from mock S3 → local temp dir
              await sync.download(userId);

              // Upload from local temp dir → mock S3 (captured in `uploaded`)
              await sync.upload(userId);

              // Assert: uploaded keys match original keys
              const originalKeys = new Set(originalStore.keys());
              const uploadedKeys = new Set(uploaded.keys());
              expect(uploadedKeys).toEqual(originalKeys);

              // Assert: uploaded content is byte-identical to originals
              for (const [key, originalBuf] of originalStore) {
                const uploadedBuf = uploaded.get(key);
                expect(uploadedBuf).toBeDefined();
                expect(uploadedBuf!.equals(originalBuf)).toBe(true);
              }
            } finally {
              fs.rmSync(rtTmpDir, { recursive: true, force: true });
            }
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});
