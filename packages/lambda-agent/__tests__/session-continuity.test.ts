import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionSync } from "../src/session-sync.js";
import {
  SESSION_S3_PREFIX,
  SESSION_DEFAULT_AGENT,
} from "@serverless-openclaw/shared";

/**
 * Session Continuity Integration Tests
 *
 * These tests verify that session transcript files (JSONL) are correctly
 * stored and retrieved so that conversation context is preserved across:
 * - Multiple Lambda invocations (warm and cold)
 * - Lambda → Fargate transitions
 * - Fargate → Lambda transitions
 * - Mixed routing patterns
 *
 * We simulate S3 with an in-memory store and verify that both Lambda's
 * SessionSync and Fargate's lifecycle would read/write the same S3 keys.
 */

// Simulated S3 in-memory store
const s3Store = new Map<string, string>();

// Mock S3 client that uses in-memory store
const mockSend = vi.fn().mockImplementation((cmd: Record<string, unknown>) => {
  const input = cmd as Record<string, unknown>;

  if (input._type === "GetObjectCommand") {
    const key = (input as { Key: string }).Key;
    const content = s3Store.get(key);
    if (!content) {
      const err = new Error("NoSuchKey");
      (err as Error & { name: string }).name = "NoSuchKey";
      return Promise.reject(err);
    }
    return Promise.resolve({
      Body: { transformToString: () => Promise.resolve(content) },
    });
  }

  if (input._type === "PutObjectCommand") {
    const key = (input as { Key: string }).Key;
    const body = (input as { Body: string }).Body;
    s3Store.set(key, body);
    return Promise.resolve({});
  }

  return Promise.resolve({});
});

import { vi } from "vitest";

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: mockSend })),
  GetObjectCommand: vi.fn().mockImplementation((params) => ({
    ...params,
    _type: "GetObjectCommand",
  })),
  PutObjectCommand: vi.fn().mockImplementation((params) => ({
    ...params,
    _type: "PutObjectCommand",
  })),
}));

describe("Session Continuity", () => {
  let tmpDir: string;
  const userId = "user-test-123";
  const sessionId = "main";
  const bucket = "test-bucket";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-continuity-"));
    s3Store.clear();
    mockSend.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Helper: create a JSONL session transcript with messages */
  function createTranscript(messages: Array<{ role: string; content: string }>): string {
    const header = JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: Date.now() });
    const lines = messages.map((m) =>
      JSON.stringify({ type: "message", message: { role: m.role, content: m.content, timestamp: Date.now() } }),
    );
    return [header, ...lines].join("\n") + "\n";
  }

  /** Helper: parse transcript to extract messages */
  function parseMessages(content: string): Array<{ role: string; content: string }> {
    return content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry: { type: string }) => entry.type === "message")
      .map((entry: { message: { role: string; content: string } }) => ({
        role: entry.message.role,
        content: entry.message.content,
      }));
  }

  /** Helper: get the unified S3 key for a session */
  function getExpectedS3Key(): string {
    return `${SESSION_S3_PREFIX}/${userId}/agents/${SESSION_DEFAULT_AGENT}/sessions/${sessionId}.jsonl`;
  }

  /** Helper: simulate a Lambda invocation that appends a user+assistant message pair */
  async function simulateLambdaInvocation(
    sync: SessionSync,
    userMsg: string,
    assistantMsg: string,
  ): Promise<void> {
    // Download existing session
    const localPath = await sync.download(userId, sessionId);

    // Read existing content (or empty for new session)
    let existing = "";
    if (fs.existsSync(localPath)) {
      existing = fs.readFileSync(localPath, "utf-8");
    }

    // If no existing content, create header
    if (!existing) {
      existing = JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: Date.now() }) + "\n";
    }

    // Append user + assistant messages (simulating OpenClaw's SessionManager behavior)
    existing += JSON.stringify({ type: "message", message: { role: "user", content: userMsg, timestamp: Date.now() } }) + "\n";
    existing += JSON.stringify({ type: "message", message: { role: "assistant", content: assistantMsg, timestamp: Date.now() } }) + "\n";
    fs.writeFileSync(localPath, existing, "utf-8");

    // Upload back to S3
    await sync.upload(userId, sessionId);
  }

  /** Helper: simulate Fargate writing a session to the same S3 path */
  function simulateFargateBackup(userMsg: string, assistantMsg: string, existingContent?: string): void {
    let content = existingContent ?? "";
    if (!content) {
      content = JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: Date.now() }) + "\n";
    }
    content += JSON.stringify({ type: "message", message: { role: "user", content: userMsg, timestamp: Date.now() } }) + "\n";
    content += JSON.stringify({ type: "message", message: { role: "assistant", content: assistantMsg, timestamp: Date.now() } }) + "\n";
    s3Store.set(getExpectedS3Key(), content);
  }

  // ── Pattern 1: Lambda → Lambda (same session) ──

  describe("Lambda → Lambda continuity", () => {
    it("should preserve context across two Lambda invocations", async () => {
      const sync = new SessionSync(bucket, tmpDir);

      // First invocation
      await simulateLambdaInvocation(sync, "What is 2+2?", "4");

      // Clear /tmp (simulates cold start on different instance)
      const localPath = sync.getLocalPath(sessionId);
      fs.rmSync(localPath, { force: true });

      // Second invocation — should download from S3 and see previous messages
      await simulateLambdaInvocation(sync, "Multiply that by 10", "40");

      const finalContent = s3Store.get(getExpectedS3Key())!;
      const messages = parseMessages(finalContent);

      expect(messages).toHaveLength(4);
      expect(messages[0].content).toBe("What is 2+2?");
      expect(messages[1].content).toBe("4");
      expect(messages[2].content).toBe("Multiply that by 10");
      expect(messages[3].content).toBe("40");
    });

    it("should handle three consecutive Lambda invocations", async () => {
      const sync = new SessionSync(bucket, tmpDir);

      await simulateLambdaInvocation(sync, "Hello", "Hi there!");
      await simulateLambdaInvocation(sync, "My name is Alice", "Nice to meet you, Alice!");
      await simulateLambdaInvocation(sync, "What is my name?", "Your name is Alice.");

      const messages = parseMessages(s3Store.get(getExpectedS3Key())!);
      expect(messages).toHaveLength(6);
      expect(messages[4].content).toBe("What is my name?");
      expect(messages[5].content).toBe("Your name is Alice.");
    });
  });

  // ── Pattern 2: Fargate → Lambda transition ──

  describe("Fargate → Lambda continuity", () => {
    it("should read Fargate session when Lambda starts", async () => {
      // Fargate had a conversation and backed up to S3
      simulateFargateBackup("Tell me a joke", "Why did the chicken cross the road?");

      // Lambda picks up from S3
      const sync = new SessionSync(bucket, tmpDir);
      await simulateLambdaInvocation(sync, "That's funny! Tell another", "Knock knock!");

      const messages = parseMessages(s3Store.get(getExpectedS3Key())!);
      expect(messages).toHaveLength(4);
      expect(messages[0].content).toBe("Tell me a joke");
      expect(messages[1].content).toBe("Why did the chicken cross the road?");
      expect(messages[2].content).toBe("That's funny! Tell another");
      expect(messages[3].content).toBe("Knock knock!");
    });
  });

  // ── Pattern 3: Lambda → Fargate transition ──

  describe("Lambda → Fargate continuity", () => {
    it("should make Lambda session available for Fargate restore", async () => {
      const sync = new SessionSync(bucket, tmpDir);

      // Lambda has a conversation
      await simulateLambdaInvocation(sync, "Remember: the password is 42", "Got it, I'll remember 42.");

      // Verify S3 has the session at the unified path
      const s3Key = getExpectedS3Key();
      expect(s3Store.has(s3Key)).toBe(true);

      // Fargate restoreFromS3 would download from same path
      const content = s3Store.get(s3Key)!;
      const messages = parseMessages(content);
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe("Remember: the password is 42");
      expect(messages[1].content).toBe("Got it, I'll remember 42.");
    });
  });

  // ── Pattern 4: Mixed routing (Lambda → Fargate → Lambda) ──

  describe("Mixed routing continuity", () => {
    it("should maintain full context across Lambda → Fargate → Lambda", async () => {
      const sync = new SessionSync(bucket, tmpDir);

      // Step 1: Lambda conversation
      await simulateLambdaInvocation(sync, "My favorite color is blue", "Blue is a great choice!");

      // Step 2: Fargate picks up and adds to conversation
      const afterLambda = s3Store.get(getExpectedS3Key())!;
      simulateFargateBackup("What is my favorite color?", "Your favorite color is blue!", afterLambda);

      // Step 3: Lambda picks up again (clear /tmp to simulate cold start)
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(tmpDir, { recursive: true });

      await simulateLambdaInvocation(sync, "And my favorite number?", "You haven't told me your favorite number yet.");

      const messages = parseMessages(s3Store.get(getExpectedS3Key())!);
      expect(messages).toHaveLength(6);
      expect(messages[0].content).toBe("My favorite color is blue");
      expect(messages[1].content).toBe("Blue is a great choice!");
      expect(messages[2].content).toBe("What is my favorite color?");
      expect(messages[3].content).toBe("Your favorite color is blue!");
      expect(messages[4].content).toBe("And my favorite number?");
      expect(messages[5].content).toBe("You haven't told me your favorite number yet.");
    });

    it("should maintain context across Fargate → Lambda → Fargate", async () => {
      const sync = new SessionSync(bucket, tmpDir);

      // Step 1: Fargate starts
      simulateFargateBackup("Set a reminder for 3pm", "Reminder set for 3pm.");

      // Step 2: Lambda takes over
      await simulateLambdaInvocation(sync, "What reminder did I set?", "You set a reminder for 3pm.");

      // Step 3: Fargate resumes
      const afterLambda = s3Store.get(getExpectedS3Key())!;
      simulateFargateBackup("Cancel that reminder", "Reminder cancelled.", afterLambda);

      const messages = parseMessages(s3Store.get(getExpectedS3Key())!);
      expect(messages).toHaveLength(6);
      expect(messages[0].content).toBe("Set a reminder for 3pm");
      expect(messages[3].content).toBe("You set a reminder for 3pm.");
      expect(messages[5].content).toBe("Reminder cancelled.");
    });
  });

  // ── Pattern 5: New session (no prior context) ──

  describe("New session", () => {
    it("should create a new session on first Lambda invocation", async () => {
      const sync = new SessionSync(bucket, tmpDir);

      await simulateLambdaInvocation(sync, "First message ever", "Welcome!");

      const messages = parseMessages(s3Store.get(getExpectedS3Key())!);
      expect(messages).toHaveLength(2);
    });

    it("should not fail when S3 has no prior session", async () => {
      const sync = new SessionSync(bucket, tmpDir);

      const localPath = await sync.download(userId, sessionId);
      expect(fs.existsSync(localPath)).toBe(false); // No file created
    });
  });

  // ── Pattern 6: S3 key format validation ──

  describe("Unified S3 key format", () => {
    it("should use the same S3 path that Fargate lifecycle would use", async () => {
      const sync = new SessionSync(bucket, tmpDir);
      await simulateLambdaInvocation(sync, "test", "ok");

      // Verify the key matches the Fargate convention:
      // {SESSION_S3_PREFIX}/{userId}/agents/{agent}/sessions/{sessionId}.jsonl
      const expectedKey = `sessions/${userId}/agents/default/sessions/main.jsonl`;
      expect(s3Store.has(expectedKey)).toBe(true);
    });

    it("should store with correct content type", async () => {
      const sync = new SessionSync(bucket, tmpDir);
      const localPath = sync.getLocalPath(sessionId);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, '{"type":"session"}\n');

      await sync.upload(userId, sessionId);

      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          ContentType: "application/x-ndjson",
        }),
      );
    });
  });

  // ── Pattern 7: Concurrent user isolation ──

  describe("User isolation", () => {
    it("should keep different users' sessions separate", async () => {
      const sync = new SessionSync(bucket, tmpDir);

      // User A conversation
      const userA = "user-alice";
      const localPathA = await sync.download(userA, sessionId);
      fs.mkdirSync(path.dirname(localPathA), { recursive: true });
      const contentA = createTranscript([
        { role: "user", content: "I am Alice" },
        { role: "assistant", content: "Hello Alice!" },
      ]);
      fs.writeFileSync(localPathA, contentA);
      await sync.upload(userA, sessionId);

      // User B conversation
      const userB = "user-bob";
      const localPathB = await sync.download(userB, sessionId);
      fs.mkdirSync(path.dirname(localPathB), { recursive: true });
      const contentB = createTranscript([
        { role: "user", content: "I am Bob" },
        { role: "assistant", content: "Hello Bob!" },
      ]);
      fs.writeFileSync(localPathB, contentB);
      await sync.upload(userB, sessionId);

      // Verify isolation
      const keyA = `sessions/${userA}/agents/default/sessions/main.jsonl`;
      const keyB = `sessions/${userB}/agents/default/sessions/main.jsonl`;
      expect(s3Store.has(keyA)).toBe(true);
      expect(s3Store.has(keyB)).toBe(true);

      const messagesA = parseMessages(s3Store.get(keyA)!);
      const messagesB = parseMessages(s3Store.get(keyB)!);
      expect(messagesA[0].content).toBe("I am Alice");
      expect(messagesB[0].content).toBe("I am Bob");
    });
  });
});
