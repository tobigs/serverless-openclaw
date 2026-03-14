import { describe, it, expect } from "vitest";
import { classifyRoute, stripRouteHint } from "../../src/services/route-classifier.js";
import type { TaskStateItem } from "@serverless-openclaw/shared";

const runningTask: TaskStateItem = {
  PK: "USER#user-123",
  taskArn: "arn:task",
  status: "Running",
  publicIp: "1.2.3.4",
  startedAt: "2024-01-01T00:00:00Z",
  lastActivity: "2024-01-01T00:00:00Z",
};

describe("classifyRoute", () => {
  it("returns 'fargate-reuse' when taskState is Running with publicIp", () => {
    const result = classifyRoute({ message: "hello", taskState: runningTask });
    expect(result).toBe("fargate-reuse");
  });

  it("returns 'lambda' when taskState is Running WITHOUT publicIp", () => {
    const taskWithoutIp: TaskStateItem = { ...runningTask, publicIp: undefined };
    const result = classifyRoute({ message: "hello", taskState: taskWithoutIp });
    expect(result).toBe("lambda");
  });

  it("returns 'lambda' when taskState is null", () => {
    const result = classifyRoute({ message: "hello", taskState: null });
    expect(result).toBe("lambda");
  });

  it("returns 'lambda' when taskState is Starting", () => {
    const startingTask: TaskStateItem = {
      PK: "USER#user-123",
      taskArn: "arn:task",
      status: "Starting",
      startedAt: "2024-01-01T00:00:00Z",
      lastActivity: "2024-01-01T00:00:00Z",
    };
    const result = classifyRoute({ message: "hello", taskState: startingTask });
    expect(result).toBe("lambda");
  });

  it("returns 'fargate-new' when message starts with '/heavy'", () => {
    const result = classifyRoute({ message: "/heavy do something", taskState: null });
    expect(result).toBe("fargate-new");
  });

  it("returns 'fargate-new' when message starts with '/fargate'", () => {
    const result = classifyRoute({ message: "/fargate run this", taskState: null });
    expect(result).toBe("fargate-new");
  });

  it("returns 'fargate-new' when message has leading spaces before '/heavy'", () => {
    const result = classifyRoute({ message: "   /heavy compute", taskState: null });
    expect(result).toBe("fargate-new");
  });

  it("returns 'lambda' for normal messages", () => {
    const result = classifyRoute({ message: "what is the weather?", taskState: null });
    expect(result).toBe("lambda");
  });
});

describe("stripRouteHint", () => {
  it("removes '/heavy ' prefix", () => {
    expect(stripRouteHint("/heavy do something")).toBe("do something");
  });

  it("removes '/fargate ' prefix", () => {
    expect(stripRouteHint("/fargate run this")).toBe("run this");
  });

  it("returns original message when no hint", () => {
    expect(stripRouteHint("hello world")).toBe("hello world");
  });
});
