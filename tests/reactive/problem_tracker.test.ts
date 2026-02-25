import { describe, it, expect } from "vitest";
import { ProblemTracker } from "../../src/reactive/problem_tracker";
import type { Problem } from "../../src/reactive/problem_tracking_types";

describe("ProblemTracker", () => {
  it("setProblems 覆盖式写入 + clear", () => {
    const tracker = new ProblemTracker();

    const p1: Problem = {
      type: "undefined_input",
      severity: "error",
      entityId: "c1",
      message: "missing",
      computationId: "c1",
      undefinedInputs: ["x" as any],
    };

    const p2: Problem = {
      type: "output_conflict",
      severity: "error",
      entityId: "c1",
      message: "conflict",
      conflictingOutput: "y" as any,
      existingProducer: "a",
      newProducer: "c1",
    };

    tracker.setProblems("c1", [p1]);
    expect(tracker.getProblemsOf("c1")).toHaveLength(1);
    expect(tracker.isHealthy("c1")).toBe(false);

    tracker.setProblems("c1", [p2]);
    expect(tracker.getProblemsOf("c1")).toHaveLength(1);
    expect(tracker.getProblemsOf("c1")[0].type).toBe("output_conflict");

    tracker.clearProblems("c1");
    expect(tracker.getProblemsOf("c1")).toHaveLength(0);
    expect(tracker.isHealthy("c1")).toBe(true);
  });

  it("getProblems 支持过滤", () => {
    const tracker = new ProblemTracker();

    tracker.setProblems("c1", [
      {
        type: "undefined_input",
        severity: "error",
        entityId: "c1",
        message: "missing",
        computationId: "c1",
        undefinedInputs: ["x" as any],
      },
    ]);

    tracker.setProblems("c2", [
      {
        type: "output_conflict",
        severity: "error",
        entityId: "c2",
        message: "conflict",
        conflictingOutput: "y" as any,
        existingProducer: "a",
        newProducer: "c2",
      },
    ]);

    expect(tracker.getProblems().length).toBe(2);
    expect(tracker.getProblems({ type: "undefined_input" }).every(p => p.type === "undefined_input")).toBe(true);
    expect(tracker.getProblems({ entityId: "c2" })).toHaveLength(1);
  });
});

