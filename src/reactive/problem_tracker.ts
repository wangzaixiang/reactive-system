import type { Problem, ProblemSeverity, ProblemType } from "./problem_tracking_types";

/**
 * ProblemTracker - 负责记录和查询系统级问题
 *
 * 约束：
 * - 仅保存“系统级问题”（即系统状态确实受影响、需要后续修复/重试的那类问题）
 * - 对同一 entityId 采用覆盖式写入（避免叠加旧问题造成语义漂移）
 */
export class ProblemTracker {
  private problemsByEntity: Map<string, Problem[]> = new Map();

  /**
   * 覆盖设置某个实体的全部问题（用于一次 define/repair 重评估后写入）
   */
  setProblems(entityId: string, problems: Problem[]): void {
    if (problems.length === 0) {
      this.problemsByEntity.delete(entityId);
      return;
    }
    this.problemsByEntity.set(entityId, problems);
  }

  /**
   * 清除某个实体的全部问题
   */
  clearProblems(entityId: string): void {
    this.problemsByEntity.delete(entityId);
  }

  /**
   * 获取某个实体的问题（不存在则返回空数组）
   */
  getProblemsOf(entityId: string): Problem[] {
    return this.problemsByEntity.get(entityId) ?? [];
  }

  /**
   * 获取所有问题（可选过滤）
   */
  getProblems(filter?: {
    type?: ProblemType;
    severity?: ProblemSeverity;
    entityId?: string;
  }): Problem[] {
    if (!filter || Object.keys(filter).length === 0) {
      return this.getAllProblems();
    }

    const results: Problem[] = [];
    for (const [entityId, problems] of this.problemsByEntity.entries()) {
      if (filter.entityId && filter.entityId !== entityId) continue;
      for (const p of problems) {
        if (filter.type && p.type !== filter.type) continue;
        if (filter.severity && p.severity !== filter.severity) continue;
        results.push(p);
      }
    }
    return results;
  }

  /**
   * 获取所有问题（不带过滤）
   */
  getAllProblems(): Problem[] {
    const all: Problem[] = [];
    for (const problems of this.problemsByEntity.values()) {
      all.push(...problems);
    }
    return all;
  }

  /**
   * 判断某个实体是否健康 (pure)
   */
  isHealthy(entityId: string): boolean {
    const problems = this.problemsByEntity.get(entityId);
    return !problems || problems.length === 0;
  }
}

