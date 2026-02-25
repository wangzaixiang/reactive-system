import type {Observer, ReactiveModuleOptions, Unsubscribe, VariableId} from "./types";
import { Variable } from "./variable";
import { Computation } from "./computation";
import { ProblemComputation } from "./problem_types";
import { ProblemTracker } from "./problem_tracker";

/**
 * ReactiveModuleCore - 响应式系统的最小核心底座
 *
 * 职责：
 * - 保存核心状态（variables/computations/readyQueue 等）
 * - 提供日志与基础查询能力
 * - 提供 observe 与通用 helper
 *
 * 非职责：
 * - 不包含 define/pending/problem/repair/redefine/remove 等策略逻辑
 */
export abstract class ReactiveModuleCore {
  protected options: Required<ReactiveModuleOptions>;
  protected logicalClock: number = 0; // 逻辑时钟 T

  protected variables: Map<VariableId, Variable> = new Map();
  protected computations: Map<string, Computation> = new Map();

  // Problem Recovery Redesign
  protected problem_variables: Map<VariableId, Variable> = new Map();
  protected problem_computations: Map<string, ProblemComputation> = new Map();
  protected outputWaiters: Map<VariableId, Set<string>> = new Map(); // VariableId -> Set<ComputationId>
  protected problemTracker: ProblemTracker = new ProblemTracker();


  protected constructor(options: ReactiveModuleOptions = {}) {
    this.options = {
      maxConcurrent: 16,
      abortStrategy: "deferred",
      logLevel: "error",
      assertInvariants: false,
      ...options,
    };
  }

  isLogEnabled(level: "trace" | "debug" | "info" | "error"): boolean {
    const levels = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
    const currentLevel = levels[this.options.logLevel] ?? 4;
    const messageLevel = levels[level] ?? 0;
    return messageLevel >= currentLevel;
  }

  log(
    level: "trace" | "debug" | "info" | "error",
    category: string,
    message: string,
    indent = 0
  ): void {
    const levels = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
    const currentLevel = levels[this.options.logLevel] ?? 4;
    const messageLevel = levels[level] ?? 0;

    if (messageLevel >= currentLevel) {
      const actualIndent = Math.min(indent, 6);
      const indentStr = "  ".repeat(actualIndent);
      const prefix = `[${this.logicalClock}] ${indentStr}${category}:`;

      const process = (globalThis as any)["process"];
      if (typeof process !== "undefined" && process.stderr) {
        process.stdout.write(`${prefix} ${message}\n`);
      } else {
        console.log(prefix, message);
      }
    }
  }

  protected nextLogicalClock(): number {
    return ++this.logicalClock;
  }

  protected getVariable(id: VariableId): Variable {
    return this._getVariable(id, 0);
  }

  protected _getVariable(id: VariableId, _indent: number): Variable {
    let variable = this.variables.get(id);
    if (!variable) {
        variable = this.problem_variables.get(id);
    }
    if (!variable) {
      throw new Error(`Variable ${id} not found.`);
    }
    return variable;
  }

  protected getComputation(id: string): Computation {
    const computation = this.computations.get(id);
    if (!computation) {
      throw new Error(`Computation ${id} not found.`);
    }
    return computation;
  }

  protected isInputOfComputation(variable: Variable, comp: Computation, _indent?: number): boolean {
    if (comp.staticInputs.has(variable.id)) {
      return true;
    }
    return false;
  }

  public observe(variableId: VariableId, callback: Observer): Unsubscribe {
    return this._observe(variableId, callback, 0);
  }

  protected _observe(variableId: VariableId, callback: Observer, indent: number): Unsubscribe {
    // Check normal variables first, then problem variables
    let variable = this.variables.get(variableId);
    if (!variable) {
        variable = this.problem_variables.get(variableId);
    }

    if (!variable) {
        // Fallback to throw via _getVariable logic
        this._getVariable(variableId, indent + 1);
        throw new Error(`Variable ${variableId} not found.`); // Should be unreachable if _getVariable throws
    }

    variable.observers.add(callback);
    this._propagateObserveCountUpward(variable, +1, indent + 1);

    // Immediate notification if result is available (Contract 4.3 + BehaviorSubject semantics)
    // We notify for ANY result type, including uninitialized, to reflect current state.
    if( variable.dirty === false ) {
      try {
        callback(variable.result);
      } catch (e) {
        this.log("error", "observe", `Observer callback failed: ${e}`, indent);
      }
    }

    this.isLogEnabled("trace") &&
      this.log(
        "trace",
        "observe",
        `${variable.id} (observers=${variable.observers.size}, observeCount=${variable.observeCount})`,
        indent
      );

    return () => {
      variable!.observers.delete(callback);
      this._propagateObserveCountUpward(variable!, -1, indent + 1);
      this.isLogEnabled("trace") &&
        this.log(
          "trace",
          "unobserve",
          `${variableId} (observers=${variable!.observers.size}, observeCount=${variable!.observeCount})`,
          indent
        );
    };
  }

  public abstract updateSource(id: VariableId, value: any): void;
  protected abstract _updateSource(id: VariableId, value: any, indent?: number): void;

  protected abstract _markDirty(
    variable: Variable,
    t: number,
    isNewDirty: boolean,
    indent?: number
  ): void;
  protected abstract _cleanVariable(variable: Variable, indent?: number): void;
  protected abstract _scheduleNext(indent?: number): void;
  protected abstract _propagateObserveCountUpward(
    variable: Variable,
    delta: number,
    indent?: number
  ): void;
  protected abstract _propagateCauseAtDownward(
    comp: Computation,
    newCauseAt: number,
    sourceVariable: Variable | null,
    isNewDirty: boolean,
    indent?: number
  ): void;
}

