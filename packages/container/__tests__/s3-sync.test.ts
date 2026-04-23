import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import * as fs from "node:fs";
import { restoreFromS3, backupToS3, shouldExclude } from "../src/s3-sync.js";

vi.mock("@aws-sdk/client-s3");

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
  };
});

describe("restoreFromS3", () => {
  let mockS3Send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    const s3Instance = vi.mocked(S3Client).mock.results[0]?.value;
    if (s3Instance) {
      mockS3Send = s3Instance.send;
    } else {
      mockS3Send = vi.fn();
      vi.mocked(S3Client).mockImplementation(() => ({ send: mockS3Send }) as unknown as S3Client);
    }
  });

  it("should download files from S3 to local directory", async () => {
    const mockBody = {
      transformToByteArray: vi.fn().mockResolvedValue(new Uint8Array([72, 105])),
    };
    mockS3Send = vi
      .fn()
      .mockResolvedValueOnce({
        Contents: [{ Key: "workspaces/user1/file.txt", Size: 2 }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Body: mockBody });

    vi.mocked(S3Client).mockImplementation(() => ({ send: mockS3Send }) as unknown as S3Client);

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);

    await restoreFromS3({
      bucket: "test-bucket",
      prefix: "workspaces/user1",
      localPath: "/data/workspace",
    });

    expect(mockS3Send).toHaveBeenCalledTimes(2);
    const listCmd = mockS3Send.mock.calls[0][0];
    expect(listCmd).toBeInstanceOf(ListObjectsV2Command);

    const getCmd = mockS3Send.mock.calls[1][0];
    expect(getCmd).toBeInstanceOf(GetObjectCommand);
  });

  it("should handle empty S3 prefix gracefully", async () => {
    mockS3Send = vi.fn().mockResolvedValueOnce({
      Contents: undefined,
      IsTruncated: false,
    });
    vi.mocked(S3Client).mockImplementation(() => ({ send: mockS3Send }) as unknown as S3Client);

    await restoreFromS3({
      bucket: "test-bucket",
      prefix: "workspaces/new-user",
      localPath: "/data/workspace",
    });

    expect(mockS3Send).toHaveBeenCalledTimes(1);
  });

  it("should handle paginated results", async () => {
    const mockBody = {
      transformToByteArray: vi.fn().mockResolvedValue(new Uint8Array([1])),
    };
    // Call order: list page1 → get a.txt → list page2 → get b.txt
    mockS3Send = vi
      .fn()
      .mockResolvedValueOnce({
        Contents: [{ Key: "workspaces/user1/a.txt", Size: 1 }],
        IsTruncated: true,
        NextContinuationToken: "token1",
      })
      .mockResolvedValueOnce({ Body: mockBody })
      .mockResolvedValueOnce({
        Contents: [{ Key: "workspaces/user1/b.txt", Size: 1 }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Body: mockBody });

    vi.mocked(S3Client).mockImplementation(() => ({ send: mockS3Send }) as unknown as S3Client);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);

    await restoreFromS3({
      bucket: "test-bucket",
      prefix: "workspaces/user1",
      localPath: "/data/workspace",
    });

    // 2 list calls + 2 get calls = 4
    expect(mockS3Send).toHaveBeenCalledTimes(4);
  });

  it("should not fail on S3 errors", async () => {
    mockS3Send = vi.fn().mockRejectedValueOnce(new Error("NoSuchBucket"));
    vi.mocked(S3Client).mockImplementation(() => ({ send: mockS3Send }) as unknown as S3Client);

    // Should not throw
    await restoreFromS3({
      bucket: "nonexistent",
      prefix: "workspaces/user1",
      localPath: "/data/workspace",
    });
  });
});

describe("backupToS3", () => {
  let mockS3Send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockS3Send = vi.fn().mockResolvedValue({});
    vi.mocked(S3Client).mockImplementation(() => ({ send: mockS3Send }) as unknown as S3Client);
  });

  it("should upload local files to S3", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: "file.txt", isDirectory: () => false, isFile: () => true },
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from("content"));

    await backupToS3({
      bucket: "test-bucket",
      prefix: "workspaces/user1",
      localPath: "/data/workspace",
    });

    expect(mockS3Send).toHaveBeenCalledTimes(1);
    const putCmd = mockS3Send.mock.calls[0][0];
    expect(putCmd).toBeInstanceOf(PutObjectCommand);
  });

  it("should recursively upload nested directories", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync)
      .mockReturnValueOnce([
        { name: "sub", isDirectory: () => true, isFile: () => false },
        { name: "root.txt", isDirectory: () => false, isFile: () => true },
      ] as unknown as ReturnType<typeof fs.readdirSync>)
      .mockReturnValueOnce([
        { name: "nested.txt", isDirectory: () => false, isFile: () => true },
      ] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from("data"));

    await backupToS3({
      bucket: "test-bucket",
      prefix: "workspaces/user1",
      localPath: "/data/workspace",
    });

    expect(mockS3Send).toHaveBeenCalledTimes(2);
  });

  it("should handle empty workspace directory", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    await backupToS3({
      bucket: "test-bucket",
      prefix: "workspaces/user1",
      localPath: "/data/workspace",
    });

    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it("should handle non-existent workspace directory", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await backupToS3({
      bucket: "test-bucket",
      prefix: "workspaces/user1",
      localPath: "/data/nonexistent",
    });

    expect(mockS3Send).not.toHaveBeenCalled();
  });
});

describe("shouldExclude", () => {
  it("excludes node_modules anywhere in path", () => {
    expect(shouldExclude("node_modules/foo/index.js")).toBe(true);
    expect(shouldExclude("skills/x/node_modules/bar.js")).toBe(true);
  });

  it("excludes .git, bin, .cache, __pycache__, .venv segments", () => {
    expect(shouldExclude(".git/HEAD")).toBe(true);
    expect(shouldExclude("bin/uv")).toBe(true);
    expect(shouldExclude(".cache/pip/a.whl")).toBe(true);
    expect(shouldExclude("skill/__pycache__/m.pyc")).toBe(true);
    expect(shouldExclude(".venv/lib/python/x.py")).toBe(true);
  });

  it("excludes binary/document extensions", () => {
    expect(shouldExclude("things/manuals/appliance.pdf")).toBe(true);
    expect(shouldExclude("bin/tool.exe")).toBe(true);
    expect(shouldExclude("lib/foo.so")).toBe(true);
  });

  it("excludes files over 2 MiB", () => {
    expect(shouldExclude("data/big.md", 3 * 1024 * 1024)).toBe(true);
    expect(shouldExclude("data/small.md", 1024)).toBe(false);
  });

  it("allows ordinary user content", () => {
    expect(shouldExclude("shopping-list.md")).toBe(false);
    expect(shouldExclude("things-i-own/kitchen/appliances.md")).toBe(false);
    expect(shouldExclude("memory/notes.txt")).toBe(false);
  });
});

describe("restoreFromS3 with exclude list", () => {
  let mockS3Send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips GetObject for excluded keys", async () => {
    const mockBody = {
      transformToByteArray: vi.fn().mockResolvedValue(new Uint8Array([1])),
    };
    mockS3Send = vi
      .fn()
      .mockResolvedValueOnce({
        Contents: [
          { Key: "workspaces/u/node_modules/a.js", Size: 10 },
          { Key: "workspaces/u/bin/uv", Size: 49_000_000 },
          { Key: "workspaces/u/shopping-list.md", Size: 500 },
        ],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Body: mockBody });

    vi.mocked(S3Client).mockImplementation(() => ({ send: mockS3Send }) as unknown as S3Client);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);

    await restoreFromS3({
      bucket: "b",
      prefix: "workspaces/u",
      localPath: "/data/workspace",
    });

    // 1 list + 1 get (only shopping-list.md survives)
    expect(mockS3Send).toHaveBeenCalledTimes(2);
    const getCmd = mockS3Send.mock.calls[1][0];
    expect(getCmd).toBeInstanceOf(GetObjectCommand);
  });
});

describe("backupToS3 with exclude list", () => {
  let mockS3Send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockS3Send = vi.fn().mockResolvedValue({});
    vi.mocked(S3Client).mockImplementation(() => ({ send: mockS3Send }) as unknown as S3Client);
  });

  it("does not upload node_modules or large PDFs", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValueOnce([
      { name: "node_modules", isDirectory: () => true, isFile: () => false },
      { name: "shopping-list.md", isDirectory: () => false, isFile: () => true },
      { name: "appliance.pdf", isDirectory: () => false, isFile: () => true },
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from("content"));

    await backupToS3({
      bucket: "b",
      prefix: "workspaces/u",
      localPath: "/data/workspace",
    });

    // Only shopping-list.md uploaded
    expect(mockS3Send).toHaveBeenCalledTimes(1);
  });
});
