/**
 * Problem Tracking Types
 *
 * 设计文档：fpt/features/reactive-api/design_problem_tracking.md
 *
 * 注意：这是 Phase 2 的 API stub 定义，仅用于编译通过，不包含实现逻辑。
 * 完整实现将在 Phase 3-4 中完成。
 */

import { VariableId } from "./types";

// ============================================================================
// Problem ADT (Discriminated Union)
// ============================================================================

/**
 * 重复定义问题
 *
 * 场景：
 * - 尝试定义已存在的 Source 或 Computation
 * - 不带 allowRedefinition 选项
 */
export interface DuplicateDefinitionProblem {
  readonly type: 'duplicate_definition';
  readonly severity: 'error';
  readonly entityId: string;
  readonly message: string;
  readonly existingEntityType: 'source' | 'computation';
  readonly attemptedRedefinition: boolean;
}

/**
 * 输入变量未定义问题
 *
 * 场景：
 * - Computation 引用了未定义的输入变量
 * - 允许挂起，等待后续修复
 */
export interface UndefinedInputProblem {
  readonly type: 'undefined_input';
  readonly severity: 'error';
  readonly entityId: string;
  readonly message: string;
  readonly computationId: string;
  readonly undefinedInputs: VariableId[];
}

/**
 * 循环依赖问题
 *
 * 场景：
 * - DFG 中存在环路
 * - 例如：A → B → C → A
 */
export interface CircularDependencyProblem {
  readonly type: 'circular_dependency';
  readonly severity: 'error';
  readonly entityId: string;
  readonly message: string;
  readonly cycle: string[]; // 循环路径，例如：['A', 'B', 'C', 'A']
}

/**
 * 输出变量冲突问题
 *
 * 场景：
 * - 多个 Computation 尝试产生同一个输出变量
 */
export interface OutputConflictProblem {
  readonly type: 'output_conflict';
  readonly severity: 'error';
  readonly entityId: string;
  readonly message: string;
  readonly conflictingOutput: VariableId;
  readonly existingProducer: string;
  readonly newProducer: string;
}

/**
 * 实体不存在问题
 *
 * 场景：
 * - removeSource/removeComputation 时目标不存在
 * - get*Status 时目标不存在（此时也可直接抛异常，视 API 选择）
 */
export interface NotFoundProblem {
  readonly type: 'not_found';
  readonly severity: 'error';
  readonly entityId: string;
  readonly message: string;
  readonly entityType: 'source' | 'computation' | 'variable';
}

/**
 * 非法操作问题
 *
 * 场景：
 * - removeSource 试图删除 computed variable
 * - defineSource allowRedefinition 试图覆盖 computed variable
 */
export interface InvalidOperationProblem {
  readonly type: 'invalid_operation';
  readonly severity: 'error';
  readonly entityId: string;
  readonly message: string;
  readonly operation: string;
}

/**
 * Problem ADT - 所有问题类型的联合
 *
 * 使用 discriminated union 实现 ADT：
 * - TypeScript 可以根据 type 字段自动收窄类型
 * - 支持穷尽性检查（exhaustiveness checking）
 * - 不可变（所有字段标记为 readonly）
 */
export type Problem =
  | DuplicateDefinitionProblem
  | UndefinedInputProblem
  | CircularDependencyProblem
  | OutputConflictProblem
  | NotFoundProblem
  | InvalidOperationProblem;

/**
 * 问题严重程度
 */
export type ProblemSeverity = 'error' | 'warning';

/**
 * 问题类型（用于过滤查询）
 */
export type ProblemType =
  | 'duplicate_definition'
  | 'undefined_input'
  | 'circular_dependency'
  | 'output_conflict'
  | 'not_found'
  | 'invalid_operation';

// ============================================================================
// Status Types
// ============================================================================

/**
 * Source Variable 的定义状态
 *
 * 健康状态：
 * - healthy: 定义成功，无问题
 * - problematic: 定义失败或有问题
 */
export interface SourceStatus {
  id: VariableId;
  status: 'healthy' | 'problematic';
  problems: Problem[]; // 与此 Source 相关的问题列表
}

/**
 * Computation 的定义状态
 *
 * 健康状态：
 * - healthy: 定义成功，无问题
 * - problematic: 定义失败或有问题（可能挂起，等待修复）
 */
export interface ComputationStatus {
  id: string;
  status: 'healthy' | 'problematic';
  problems: Problem[]; // 与此 Computation 相关的问题列表
}

/**
 * 删除操作的状态
 *
 * 用于 removeSource 和 removeComputation 的返回值
 */
export interface RemovalStatus {
  id: string;
  success: boolean;
  affectedComputations: string[]; // 受影响的下游 Computation ID 列表
  problems: Problem[]; // 如果失败，包含错误信息
}

// ============================================================================
// Factory Functions (Optional, for type safety)
// ============================================================================

/**
 * 创建 DuplicateDefinitionProblem
 */
export function createDuplicateDefinitionProblem(
  entityId: string,
  existingEntityType: 'source' | 'computation',
  attemptedRedefinition: boolean = false
): DuplicateDefinitionProblem {
  return {
    type: 'duplicate_definition',
    severity: 'error',
    entityId,
    message: `${existingEntityType} '${entityId}' already defined. Redefining is not yet supported.`,
    existingEntityType,
    attemptedRedefinition,
  };
}

/**
 * 创建 UndefinedInputProblem
 */
export function createUndefinedInputProblem(
  computationId: string,
  undefinedInputs: VariableId[]
): UndefinedInputProblem {
  return {
    type: 'undefined_input',
    severity: 'error',
    entityId: computationId,
    message: `Computation '${computationId}' references undefined input variable(s): ${undefinedInputs.join(', ')}`,
    computationId,
    undefinedInputs,
  };
}

/**
 * 创建 CircularDependencyProblem
 */
export function createCircularDependencyProblem(
  entityId: string,
  cycle: string[]
): CircularDependencyProblem {
  return {
    type: 'circular_dependency',
    severity: 'error',
    entityId,
    message: `Circular dependency detected: ${cycle.join(' → ')}`,
    cycle,
  };
}

/**
 * 创建 OutputConflictProblem
 */
export function createOutputConflictProblem(
  newProducer: string,
  conflictingOutput: VariableId,
  existingProducer: string
): OutputConflictProblem {
  return {
    type: 'output_conflict',
    severity: 'error',
    entityId: newProducer,
    message: `Output variable '${conflictingOutput}' is already produced by '${existingProducer}'`,
    conflictingOutput,
    existingProducer,
    newProducer,
  };
}

/**
 * 创建 NotFoundProblem
 */
export function createNotFoundProblem(
  entityId: string,
  entityType: 'source' | 'computation' | 'variable'
): NotFoundProblem {
  return {
    type: 'not_found',
    severity: 'error',
    entityId,
    message: `${entityType} '${entityId}' not found`,
    entityType,
  };
}

/**
 * 创建 InvalidOperationProblem
 */
export function createInvalidOperationProblem(
  entityId: string,
  operation: string,
  message: string
): InvalidOperationProblem {
  return {
    type: 'invalid_operation',
    severity: 'error',
    entityId,
    operation,
    message,
  };
}

// ============================================================================
// Type Guards (for type narrowing)
// ============================================================================

/**
 * 类型守卫：检查是否为 DuplicateDefinitionProblem
 */
export function isDuplicateDefinitionProblem(
  problem: Problem
): problem is DuplicateDefinitionProblem {
  return problem.type === 'duplicate_definition';
}

/**
 * 类型守卫：检查是否为 UndefinedInputProblem
 */
export function isUndefinedInputProblem(
  problem: Problem
): problem is UndefinedInputProblem {
  return problem.type === 'undefined_input';
}

/**
 * 类型守卫：检查是否为 CircularDependencyProblem
 */
export function isCircularDependencyProblem(
  problem: Problem
): problem is CircularDependencyProblem {
  return problem.type === 'circular_dependency';
}

/**
 * 类型守卫：检查是否为 OutputConflictProblem
 */
export function isOutputConflictProblem(
  problem: Problem
): problem is OutputConflictProblem {
  return problem.type === 'output_conflict';
}

/**
 * 类型守卫：检查是否为 NotFoundProblem
 */
export function isNotFoundProblem(problem: Problem): problem is NotFoundProblem {
  return problem.type === 'not_found';
}

/**
 * 类型守卫：检查是否为 InvalidOperationProblem
 */
export function isInvalidOperationProblem(
  problem: Problem
): problem is InvalidOperationProblem {
  return problem.type === 'invalid_operation';
}
