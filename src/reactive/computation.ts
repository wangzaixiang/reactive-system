import {
    ComputationFn,
    ComputationState,
    RunningTask,
    VariableId
} from "./types";
import {Variable} from "./variable";

/**
 * IReactiveModuleScheduler - Computation 依赖的调度器接口
 * 用于避免循环依赖
 */
export interface IReactiveModuleScheduler {
    addToReadyQueue(comp: Computation): void;
}

/**
 * Computation - Computation 的内部表示
 */
export class Computation {
    id: string;
    staticInputs: Set<VariableId>; // 定义时声明的输入变量 ID 集合
    runtimeInputs: Set<Variable>; // 运行时实际访问的输入变量对象集合
    outputs: Map<VariableId, Variable>; // 该 Computation 产生的所有输出变量
    body: ComputationFn; // 实际的计算函数

    // 上次成功执行时的输入版本，用于 Input Pruning
    // 等于上次执行时所有 runtimeInputs 的最大 value_at
    input_version: number;

    runningTask: RunningTask | null;  // 正在稳定执行的任务
    abortingTasks: Set<RunningTask>;  // 正在 abort 的任务（等待 finally 清理）

    // ========== 调度器引用（可选，用于 setter 触发调度） ==========
    private scheduler?: IReactiveModuleScheduler;

    // ========== 数据属性（带 setter，触发状态监听） ==========

    private _dirty: boolean = false;
    private _observeCount: number = 0;
    private _dirtyInputCount: number = 0;
    private _cause_at: number = 0;

    // Getter for dirty
    get dirty(): boolean {
        return this._dirty;
    }

    /**
     * Setter for dirty - 自动触发状态变化检查 SPOT
     * true:
     *  - _propagateCauseAtDownward
     *  - _propagateObserveCountUpward
     * false:
     *  - handleExecutionError (not Abort)
     *  - handleExecutionSuccess
     *  - maybeSkipExecution (（Input Pruning）)
    */
    set dirty(value: boolean) {
        if (this._dirty === value) return;
        const oldState = this.state;
        this._dirty = value;
        this.onStateChange(oldState);
    }

    // Getter for observeCount
    get observeCount(): number {
        return this._observeCount;
    }

    // Setter for observeCount - 自动触发状态变化检查
    set observeCount(value: number) {
        if (this._observeCount === value) return;
        const oldState = this.state;
        this._observeCount = value;
        this.onStateChange(oldState);
    }

    // Getter for dirtyInputCount
    get dirtyInputCount(): number {
        return this._dirtyInputCount;
    }

    // Setter for dirtyInputCount - 自动触发状态变化检查
    set dirtyInputCount(value: number) {
        if (this._dirtyInputCount === value) return;
        const oldState = this.state;
        this._dirtyInputCount = value;
        this.onStateChange(oldState);
    }

    // Getter for cause_at
    get cause_at(): number {
        return this._cause_at;
    }

    /**
     * Setter for cause_at - 自动触发 abort 检查（SPOT 原则）
     *
     * 场景：输入 cause_at 增加，但 dirty 已经是 true（状态保持 Ready）
     * 此时虽然状态不变，但 running task 基于过时的 cause_at，需要 abort
     *
     * 触发者：
     *  - _propagateCauseAtDownward
     */
    set cause_at(value: number) {
        const oldCauseAt = this._cause_at;
        this._cause_at = value;

        if (oldCauseAt !== value) {
            // cause_at 增加时，检查 task 是否过期
            this.checkAbortOnCauseAtChange(oldCauseAt, value);
        }
    }

    /**
     * 状态变化处理 - 统一的状态变化响应入口
     *
     * 当数据属性变化导致状态变化时，自动调用此方法。
     * 负责检查是否需要 abort 和调度执行。
     *
     * 契约：
     * - 只有状态真正变化时才触发 abort/调度检查
     * - Ready → Idle/Pending: 立即 abort runningTask（任务过时）
     * - * → Ready: 检查是否需要调度
     * - 调度通过 scheduler 接口进行，避免与 ReactiveModule 循环依赖
     *
     * @param oldState 变化前的状态
     */
    private onStateChange(oldState: ComputationState): void {
        const newState = this.state;
        if (oldState === newState) return;

        // 检查是否需要 abort（Ready → Idle/Pending 时，runningTask 过时）
        this.checkAbortNeeded(oldState, newState);

        // 检查是否需要调度
        this.checkScheduleNeeded(newState);
    }

    /**
     * 检查是否需要 abort 正在执行的任务
     *
     * 契约：
     * - 当状态从 Ready 变为 Idle 或 Pending 时，runningTask 过时，需要 abort
     * - 特殊情况：Ready → Idle 如果是因为 dirty=false（任务完成），则不 abort
     * - abort 后将任务移至 abortingTasks，并清空 runningTask
     *
     * @param oldState 变化前的状态
     * @param newState 当前状态
     */
    private checkAbortNeeded(oldState: ComputationState, newState: ComputationState): void {
        if (oldState !== ComputationState.Ready || this.runningTask === null) {
            return; // 只有从 Ready 状态且有 runningTask 时才可能需要 abort
        }

        // Ready → Pending: dirtyInputCount > 0，runningTask 过时
        if (newState === ComputationState.Pending) {
            this.abortTask('dirtyInputCount > 0');
            return;
        }

        // Ready → Idle: 需要区分原因
        if (newState === ComputationState.Idle) {
            // 如果 dirty=false，说明任务正常完成，不应 abort（runningTask 即将在 finally 中清理）
            // 如果 dirty=true，说明 observeCount → 0（无人观察），应该 abort
            if (this._dirty) {
                this.abortTask('observeCount → 0');
            }
            // else: dirty=false，任务正常完成，不 abort
        }
    }

    /**
     * 检查 cause_at 变化时是否需要 abort（SPOT 原则）
     *
     * 契约：
     * - 当 cause_at 增加时，检查 runningTask.cause_at 是否过期
     * - 需要区分两种场景：
     *   1. 动态依赖场景：task.cause_at == oldCauseAt（执行中动态访问新变量）
     *      → 不 abort（任务仍基于正确的时间点）
     *   2. 外部传播场景：task.cause_at < oldCauseAt（输入变化导致 cause_at 更新）
     *      → 需要 abort（任务基于过时的输入）
     *
     * 示例：
     * - 动态依赖：let a = X ? Y : Z
     *   * X 从 true 变为 false，执行中首次访问 Z
     *   * Z.cause_at = 10 > comp.cause_at = 4
     *   * 更新 comp.cause_at: 4 → 10
     *   * task.cause_at = 4 (== oldCauseAt) → 不 abort
     *
     * - 外部传播：执行过程中，X 的 cause_at 更新
     *   * task.cause_at = 4，正在执行
     *   * 外部：X.cause_at 从 4 变为 10
     *   * 传播更新 comp.cause_at: 4 → 10
     *   * task.cause_at = 4 (== oldCauseAt) 但这是外部传播
     *   * 需要 abort！
     *
     * @param oldCauseAt 变化前的 cause_at
     * @param newCauseAt 当前的 cause_at
     */
    private checkAbortOnCauseAtChange(oldCauseAt: number, newCauseAt: number): void {
        // 如果没有 running task，无需检查
        if (!this.runningTask) return;

        const taskCauseAt = this.runningTask.cause_at;

        // 场景判断：
        // 1. taskCauseAt == oldCauseAt：可能是动态依赖或外部传播的起点
        //    - 动态依赖：task 正在执行，访问到 cause_at 更大的新变量
        //    - 外部传播：task 正在执行，输入的 cause_at 刚开始增加
        //    → 关键区分：如果 taskCauseAt < newCauseAt，说明任务过期
        //
        // 2. taskCauseAt < oldCauseAt：明确的外部传播
        //    - task 基于更旧的时间点，已经过期
        //    → 需要 abort

        if (taskCauseAt < newCauseAt) {
            // 任务基于过时的 cause_at，需要 abort
            this.abortTask(`cause_at updated: ${oldCauseAt} → ${newCauseAt}, task.cause_at=${taskCauseAt}`);
        }
        // else: taskCauseAt >= newCauseAt，任务仍然有效（不应该发生，但安全起见不 abort）
    }

    /**
     * 统一的 abort 执行点（SPOT 原则）
     *
     * 所有需要 abort running task 的地方都调用此方法。
     *
     * 契约：
     * - abort 当前的 runningTask
     * - 将任务移至 abortingTasks（等待 finally 清理）
     * - 清空 runningTask
     * - 检查是否需要重新调度（因为 runningTask 清空后，可能从 Running 变为 Ready）
     *
     * @param reason abort 的原因（用于日志）
     */
    private abortTask(reason: string): void {
        if (!this.runningTask) return;

        const task = this.runningTask;
        console.info(`abortTask reason: ${reason}`);

        // 1. Abort 任务
        task.abortController.abort();

        // 2. 移至 abortingTasks
        this.abortingTasks.add(task);

        // 3. 清空 runningTask
        this.runningTask = null;

        // 4. 重新检查调度
        // 注意：即使 state 没有变化（仍是 Ready），runningTask 的清空也意味着
        // 可能需要重新调度（从 "Ready + task" 变为 "Ready + null"）
        // 这种情况下，dirty setter 可能不会触发（因为 dirty 已经是 true），
        // 所以需要显式检查调度
        this.checkScheduleNeeded(this.state);

        // 日志记录（如果需要，可以通过回调通知外部）
        // console.log(`[Computation ${this.id}] Task ${task.taskId} aborted: ${reason}`);
    }

    /**
     * 检查是否需要调度执行
     *
     * 契约：
     * - 只有 Ready 状态且未在执行时才需要调度
     * - 通过 scheduler 接口触发调度，避免直接依赖 ReactiveModule
     *
     * @param newState 当前状态
     */
    private checkScheduleNeeded(newState: ComputationState): void {
        // 只有 Ready 且未执行才调度
        if (newState === ComputationState.Ready && this.runningTask === null && this.scheduler) {
            this.scheduler.addToReadyQueue(this);
        }
    }

    // ✅ 基于 observeCount 的推导属性
    get isRecursivelyObserved(): boolean {
        return this.observeCount > 0;
    }

    // ========== 状态纯函数（基于数据属性自动计算） ==========

    /**
     * State 纯函数：state = f(dirty, observeCount, dirtyInputCount)
     *
     * 状态规则（3-State 模型）：
     * - Idle: !dirty OR observeCount = 0
     * - Pending: dirty AND observeCount > 0 AND dirtyInputCount > 0
     * - Ready: dirty AND observeCount > 0 AND dirtyInputCount = 0
     *
     * 注意：runningTask 不影响状态。当 runningTask !== null 时，状态保持 Ready（正在执行的稳定状态）
     */
    get state(): ComputationState {
        // Idle: 不需要执行（clean 或 unobserved）
        if (!this._dirty || this._observeCount === 0) {
            return ComputationState.Idle;
        }

        // Pending: 需要执行但有 dirty 输入
        if (this._dirtyInputCount > 0) {
            return ComputationState.Pending;
        }

        // Ready: 需要执行且所有输入都 ready（包括正在执行的情况）
        return ComputationState.Ready;
    }

    constructor(
        id: string,
        staticInputs: Set<VariableId>,
        outputs: Map<VariableId, Variable>,
        body: ComputationFn,
        options: {
            cause_at?: number;
            dirtyInputCount?: number;
            input_version?: number;
            observeCount?: number;
            dirty?: boolean;
        } = {}
    ) {
        this.id = id;
        this.staticInputs = staticInputs;
        this.runtimeInputs = new Set();
        this.outputs = outputs;
        this.body = body;
        this.cause_at = options.cause_at ?? 0;
        this.input_version = options.input_version ?? 0;
        this.runningTask = null;
        this.abortingTasks = new Set();

        // 初始化数据属性（通过 setter）
        this._dirty = options.dirty ?? false;
        this._observeCount = options.observeCount ?? 0;
        this._dirtyInputCount = options.dirtyInputCount ?? 0;

        // state 现在是纯函数 getter，自动从数据属性计算，不需要初始化
    }

    /**
     * 保守计算：重新计算 dirtyInputCount
     */
    private computeDirtyInputCount(): number {
        return Array.from(this.runtimeInputs).filter(v => v.dirty).length;
    }

    /**
     * 保守计算：重新计算 cause_at
     */
    private computeCauseAt(): number {
        if (this.runtimeInputs.size === 0) {
            return 0;
        }
        return Math.max(...Array.from(this.runtimeInputs).map(v => v.cause_at));
    }

    /**
     * 保守计算：重新计算 dirty 状态
     */
    private computeDirty(): boolean {
        if (this.outputs.size === 0) {
            return false;
        }
        return Array.from(this.outputs.values()).every(v => v.dirty);
    }

    /**
     * INV-C1: runtimeInputs 的边界
     */
    assertInvariantC1(): void {
        for (const input of this.runtimeInputs) {
            if (!this.staticInputs.has(input.id)) {
                throw new Error(`INV-C1 violated: ${input.id} not in staticInputs of ${this.id}`);
            }
        }
    }

    /**
     * INV-C2: cause_at 一致性
     */
    assertInvariantC2(): void {
        if (this.runtimeInputs.size > 0) {
            const expected = this.computeCauseAt();
            if (this.cause_at < expected) {
                throw new Error(`INV-C2 violated: comp.cause_at=${this.cause_at} < max(inputs.cause_at)=${expected}`);
            }
        }

        // 检查 outputs.cause_at
        for (const output of this.outputs.values()) {
            if (output.cause_at !== this.cause_at) {
                throw new Error(`INV-C2 violated: output ${output.id}.cause_at=${output.cause_at} != comp.cause_at=${this.cause_at}`);
            }
        }
    }

    /**
     * INV-C3: dirty 一致性
     */
    assertInvariantC3(): void {
        const expected = this.computeDirty();
        if (this.dirty !== expected) {
            throw new Error(`INV-C3 violated: comp.dirty=${this.dirty} != outputs.all(dirty)=${expected}`);
        }

        // 检查所有 outputs 一致
        if (this.outputs.size > 0) {
            const firstDirty = Array.from(this.outputs.values())[0].dirty;
            for (const output of this.outputs.values()) {
                if (output.dirty !== firstDirty) {
                    throw new Error(`INV-C3 violated: outputs dirty state mismatch`);
                }
            }
        }
    }

    /**
     * INV-C4: dirtyInputCount 一致性
     */
    assertInvariantC4(): void {
        const expected = this.computeDirtyInputCount();
        if (this.dirtyInputCount !== expected) {
            throw new Error(`INV-C4 violated: dirtyInputCount=${this.dirtyInputCount}, expected=${expected}`);
        }

        if (this.dirtyInputCount < 0) {
            throw new Error(`INV-C4 violated: dirtyInputCount underflow`);
        }
    }

    /**
     * INV-C5: 状态转换约束
     */
    assertInvariantC5(): void {
        switch (this.state) {
            case ComputationState.Idle:
                // Idle: !dirty OR observeCount = 0
                // So (dirty=true, observeCount=0) is valid Idle state
                if (this.dirty && this.observeCount > 0) {
                    throw new Error(`INV-C5 violated: idle but (dirty=true, observeCount>0)`);
                }
                if (this.runningTask != null) {
                    throw new Error(`INV-C5 violated: idle but has runningTask`);
                }
                break;
            case ComputationState.Pending:
                if (!this.dirty) {
                    throw new Error(`INV-C5 violated: pending but not dirty`);
                }
                if (this.dirtyInputCount === 0) {
                    throw new Error(`INV-C5 violated: pending but dirtyInputCount=0`);
                }
                if (this.runningTask != null) {
                    throw new Error(`INV-C5 violated: pending but has runningTask`);
                }
                break;
            case ComputationState.Ready:
                if (!this.dirty) {
                    throw new Error(`INV-C5 violated: ready but not dirty`);
                }
                if (this.dirtyInputCount !== 0) {
                    throw new Error(`INV-C5 violated: ready but dirtyInputCount>0`);
                }
                // Ready 状态允许 runningTask !== null（正在执行的稳定状态）
                break;
        }
    }

    /**
     * 断言所有 Computation invariants
     */
    assertInvariants(): void {
        this.assertInvariantC1();
        this.assertInvariantC2();
        this.assertInvariantC3();
        this.assertInvariantC4();
        this.assertInvariantC5();
    }
}

