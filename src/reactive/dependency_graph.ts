import type { VariableId } from "./types";

export interface ComputationShape {
  id: string;
  inputs: VariableId[];
  outputs: VariableId[];
}

/**
 * 构建 computation 依赖图（producer -> consumer）
 *
 * 约束：
 * - 假设 outputs 唯一（如不唯一，应先以 OutputConflict 处理）
 * - 仅基于静态 inputs/outputs 构建（不包含运行时动态依赖）
 */
export function buildDependencyGraph(
  shapes: Iterable<ComputationShape>
): Map<string, Set<string>> {
  const shapeList = Array.from(shapes);

  // outputVar -> producerCompId
  const producerByOutput = new Map<VariableId, string>();
  for (const shape of shapeList) {
    for (const out of shape.outputs) {
      producerByOutput.set(out, shape.id);
    }
  }

  // producer -> consumers
  const graph = new Map<string, Set<string>>();
  for (const shape of shapeList) {
    if (!graph.has(shape.id)) graph.set(shape.id, new Set());
  }

  for (const consumer of shapeList) {
    for (const input of consumer.inputs) {
      const producer = producerByOutput.get(input);
      if (!producer) continue;
      if (!graph.has(producer)) graph.set(producer, new Set());
      graph.get(producer)!.add(consumer.id);
    }
  }

  return graph;
}

/**
 * 检测某个节点是否参与环路，并返回完整循环路径（如 A -> B -> C -> A）
 *
 * 算法：DFS + 访问中栈（灰色节点）检测
 */
export function detectCycleFrom(
  graph: Map<string, Set<string>>,
  startId: string
): string[] | null {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];

  const dfs = (node: string): string[] | null => {
    visited.add(node);
    inStack.add(node);
    stack.push(node);

    const neighbors = graph.get(node) ?? new Set<string>();
    for (const next of neighbors) {
      if (!visited.has(next)) {
        const cycle = dfs(next);
        if (cycle) return cycle;
      } else if (inStack.has(next)) {
        // Found a back-edge, build cycle path
        const idx = stack.lastIndexOf(next);
        const cyclePath = stack.slice(idx);
        cyclePath.push(next);
        return cyclePath;
      }
    }

    stack.pop();
    inStack.delete(node);
    return null;
  };

  return dfs(startId);
}

