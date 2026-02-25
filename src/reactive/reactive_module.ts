import {
  ComputationState,
  ReactiveModuleOptions,
  Result,
  VariableId, Unsubscribe
} from "./types";
export {
  ComputationState
};
export type {
  ReactiveModuleOptions,
  Result,
  Unsubscribe,
  VariableId
};
export type { ProblemDiagnostic } from "./problem_types";
import {ReactiveModuleExecution} from "./module_execution";

/**
 * ReactiveModule - 响应式系统核心模块
 * 负责管理变量、计算、调度和传播。
 */
export class ReactiveModule extends ReactiveModuleExecution {


  constructor(options: ReactiveModuleOptions = {}) {
    super(options);
  }

  /**
   * 按需求值（当前时刻，自动包装事务）
   */
  async getValue(variableId: VariableId): Promise<any> {
    const variable = this._getVariable(variableId, 1);
    const result = await this.evaluate(variable); // Always retry for getValue

    if (result.type === 'success') {
      return result.value;
    } else if (result.type === 'error') {
      throw result.error;
    } else { // 'uninitialized'
      throw new Error(`Variable ${variableId} is uninitialized and has no value.`);
    }
  }

  /**
   * 获取结果对象（不抛出异常）
   */
  async getValueResult(variableId: VariableId): Promise<Result<any>> {
    const variable = this.getVariable(variableId);
    return this.evaluate(variable ); // Always retry for getValueResult, it returns the Result directly
  }


  /**
   * 查看变量的当前状态（调试用）
   *
   * 流程：
   * 1. 获取变量
   * 2. 返回其当前的 result 和 dirty 状态
   *
   * 契约：
   * - 不触发任何计算或求值
   * - 不触发观察者通知
   * - 不修改任何状态
   * - 仅用于调试和测试
   *
   * @param variableId 变量 ID
   * @returns { result: Result<any>, isDirty: boolean }
   */
    peek(variableId: VariableId): { result: Result<any>; isDirty: boolean } {
      const variable = this.getVariable(variableId);
      return {
        result: variable.result,
        isDirty: variable.dirty,
      };
    }

    /**
     * 查看 Computation 的当前状态（调试用）
     *
     * @param computationId Computation ID
     * @returns { state: ComputationState, dirtyInputCount: number, runningTask: RunningTask | null, dirty: boolean, observeCount: number, abortingTasks: Set<RunningTask> }
     */
      peekComputation(computationId: string): {
        state: ComputationState;
        dirtyInputCount: number;
        runningTask: any; // RunningTask | null
        dirty: boolean;
        cause_at: number;
        input_version: number;
        observeCount: number;
        abortingTasks: Set<any>;
        // For debugging, include derived states
        derivedDirty: boolean;
        derivedDirtyInputCount: number;
      } {
        const comp = this.getComputation(computationId);
        return {
          state: comp.state,
          dirtyInputCount: comp.dirtyInputCount,
          runningTask: comp.runningTask, // Return the actual task object, not boolean
          dirty: comp.dirty,
          cause_at: comp.cause_at,
          input_version: comp.input_version,
          observeCount: comp.observeCount,
          abortingTasks: (comp as any).abortingTasks, // Access private field for debug
          // Derived states
          derivedDirty: (comp as any).computeDirty(), // Access private method for debug
          derivedDirtyInputCount: (comp as any).computeDirtyInputCount(), // Access private method for debug
        };
      }  }
