import {ReactiveModuleBase} from "./module_base";
import {ComputationState, ReactiveModuleOptions, Result, VariableId} from "./types";
import {deepEqual} from "./utils";
import {Variable} from "./variable";
import {Computation} from "./computation";

export abstract class ReactiveModulePropagation extends ReactiveModuleBase {

    protected constructor(options: ReactiveModuleOptions = {}) {
        super(options);
    }


    /**
     * 更新源变量（触发时间戳递增）
     * 契约：
     * - 只能更新 source variable（producer 为 null）
     * - 即使值未变化，也更新 cause_at（语义：输入改变了，需要重新评估）
     * - source variable 立即变为 clean（不需要等待计算）
     * - 触发下游 computations 的重新计算
     */
    public updateSource(variableId: VariableId, value: any): void {
        this._updateSource(variableId, value, 0);
    }

    protected _updateSource(variableId: VariableId, value: any, indent: number): void {
        const currentLogicalClock = this.nextLogicalClock();
        const variable = this._getVariable(variableId, indent + 1);

        if (variable.producer !== null) {
            throw new Error(`Cannot update variable ${variableId} directly as it is produced by a computation.`);
        }

        const oldResult = variable.result;
        const newResult: Result<any> = { type: 'success', value: value };
        const oldValue = oldResult.type === 'success' ? oldResult.value : undefined;
        const valueChanged = !deepEqual(oldValue, value);   // TODO：定义compare标准, value = null 时正常处理。

        // If the value truly changes, update value_at
        if (valueChanged) {
            variable.result = newResult;
            variable.value_at = currentLogicalClock;
            this.isLogEnabled('trace') && this.log('trace', 'updateSource', `${variableId} = ${JSON.stringify(value)} (changed from ${JSON.stringify(oldValue)}, value_at=${currentLogicalClock})`, indent);
        } else {
            this.isLogEnabled('trace') && this.log('trace', 'updateSource', `${variableId} = ${JSON.stringify(value)} (unchanged, value_at=${variable.value_at})`, indent);
        }

        // Always update cause_at as input change implies re-evaluation necessity
        variable.cause_at = currentLogicalClock;
        variable.dirty = false; // Source variable is immediately clean

        // Propagate dirty status to dependents
        // Source update is treated as "new dirty" event for counters, even though it's immediately clean
        this._markDirty(variable, currentLogicalClock, true, indent + 1);

        // Clean variable to cascade dirtyInputCount decrement to dependents
        // This is critical: source变量立即clean后，需要通知下游computations减少dirtyInputCount
        this._cleanVariable(variable, indent + 1);
    }

    /**
     * 从 Variable 开始传播 dirty 状态（便利方法）
     */
    protected _markDirty(variable: Variable, t: number, isNewDirty: boolean, indent: number): void {
        this.isLogEnabled('trace') && this.log('trace', 'markDirty',
            `${variable.id} (cause_at=${t}, isNewDirty=${isNewDirty}, dependents=${variable.dependents.size})`,
            indent);

        for (const comp of variable.dependents) {
            this._propagateCauseAtDownward(comp, t, variable, isNewDirty, indent + 1);
        }
    }

    protected _cleanVariable(variable: Variable, indent: number): void {
        this.isLogEnabled('trace') && this.log('trace', 'cleanVariable', `${variable.id} (result=${variable.result.type}, observers=${variable.observers.size}, dependents=${variable.dependents.size})`, indent);

        this.notifyObservers(variable, indent + 1);

        for (const comp of variable.dependents) {
            if (this.isInputOfComputation(variable, comp, indent + 1)) {
                this.decrementDirtyInputCount(comp, variable, indent + 1);
                this.tryTransitionToReady(comp, indent + 1);
            }
        }
    }

    private notifyObservers(variable: Variable, indent: number): void {
        // Notification always happens regardless of type, assuming caller ensures it's relevant
        // (e.g. state change from fatal -> uninitialized, or uninitialized -> success)
        
        for (const observer of variable.observers) {
            const value = variable.result.type === 'success' ? variable.result.value 
                        : (variable.result.type === 'error' || variable.result.type === 'fatal') ? variable.result.error 
                        : undefined;
            this.isLogEnabled('trace') && this.log('trace', 'observer', `${variable.id} callback (type=${variable.result.type}, value=${JSON.stringify(value)})`, indent);
            observer(variable.result);
        }
    }

    private decrementDirtyInputCount(comp: Computation, variable: Variable, indent: number): void {
        // Only decrement dirtyInputCount if the input variable is a computed variable.
        // Source variables are not counted in dirtyInputCount.
        // Note: variable.dirty is already false when cleanVariable is called, so we don't check it
        if (variable.producer !== null) {
            comp.dirtyInputCount--;
            this.isLogEnabled('trace') && this.log('trace', 'cleanVariable', `${comp.id}.dirtyInputCount-- = ${comp.dirtyInputCount}`, indent);

            // 验证 dirtyInputCount 的正确性
            this.assertDirtyInputCount(comp, `after decrement (clean: ${variable.id})`, indent);
        } else {
             if (this.options.logLevel === 'trace') {
                 this.isLogEnabled('trace') && this.log('trace', 'cleanVariable', `Comp ${comp.id}: Source input ${variable.id} is clean, not decremented dirtyInputCount.`, indent);
            }
        }
    }

    private tryTransitionToReady(comp: Computation, indent: number): void {
        // 调度会通过 setter 自动触发（dirtyInputCount 变化 → 状态变化 → 自动加入 readyQueue）
        // 无需手动调度
        if (comp.state === ComputationState.Ready) {
            this.isLogEnabled('debug') && this.log('debug', 'cleanVariable', `${comp.id} -> READY (auto-scheduled via setter)`, indent);
        }
    }

    protected cleanOutputDirty(comp: Computation, indent: number): void {
        if (this.options.logLevel === 'trace') {
            this.isLogEnabled('trace') && this.log('trace', 'cleanOutputDirty', `Computation ${comp.id}`, indent);
        }
        comp.outputs.forEach(outputVar => {
            outputVar.dirty = false;
            this._cleanVariable(outputVar, indent + 1); // Cascade clean to downstream
        });
    }

    protected getMaxInputVersion(inputs: Set<Variable>): number {
        let maxVersion = 0;
        for (const input of inputs) {
            maxVersion = Math.max(maxVersion, input.value_at);
        }
        return maxVersion;
    }

    private isStale(comp: Computation): boolean {
        // If never executed (input_version=0), it is stale unless it has no inputs?
        // Actually if never executed, we should execute it.
        if (comp.input_version === 0) return true;
        
        const currentMaxInputVersion = this.getMaxInputVersion(comp.runtimeInputs);
        return currentMaxInputVersion > comp.input_version;
    }

    /**
     * 向上游递归传播 observeCount 变化
     *
     * 流程：
     * 1. 更新当前 variable 的 observeCount（+delta 或 -delta）
     * 2. 如果 variable 有 producer：
     *    a. 直接更新 producer 的 observeCount（+delta 或 -delta）
     *    b. 递归向 producer 的 runtimeInputs 传播相同的 delta
     */
    protected _propagateObserveCountUpward(
        variable: Variable,
        delta: number,
        indent: number
    ): void {
        if (delta === 0) {
            return; // 无需传播
        }

        // ========== 1. 更新当前 variable 的 observeCount ==========
        variable.observeCount += delta;
        this.isLogEnabled('trace') && this.log('trace', 'propagateObserveCountUpward',
            `${variable.id}: observeCount ${variable.observeCount - delta} -> ${variable.observeCount} (delta=${delta})`,
            indent);

        // ========== 2. 如果有 producer，向上递归传播 ==========
        if (variable.producer) {
            const producer = variable.producer;

            // 直接累加 delta（比重新计算 Σ(outputs.observeCount) 更高效）
            producer.observeCount += delta;

            this.isLogEnabled('trace') && this.log('trace', 'propagateObserveCountUpward',
                `${producer.id} (computation): observeCount ${producer.observeCount - delta} -> ${producer.observeCount} (delta=${delta})`,
                indent);

            // 递归传播到所有 runtimeInputs（用相同的 delta）
            for (const input of producer.runtimeInputs) {
                this._propagateObserveCountUpward(input, delta, indent + 1);
            }

            // 添加 observer 可能需要将上游的 cause_at 传递到下游。
            if (delta > 0 && !producer.dirty && this.isStale(producer)) {
                this.isLogEnabled('trace') && this.log('trace', 'propagateObserveCountUpward', `${producer.id} is stale, re-propagating cause_at`, indent);

                // ✅ SPOT 原则：通过重新传播 cause_at 来设置 dirty
                // 计算当前输入的最大 cause_at
                const maxInputCauseAt = Math.max(
                    ...Array.from(producer.runtimeInputs).map(v => v.cause_at)
                );

                // 如果输入的 cause_at 大于 producer 的 cause_at，重新传播
                if (maxInputCauseAt > producer.cause_at) {
                    this._propagateCauseAtDownward(
                        producer,
                        maxInputCauseAt,
                        null,      // sourceVariable: null (陈旧性检测，不是特定输入触发)
                        false,     // isNewDirty: false (不增加 dirtyInputCount，因为输入已经 clean)
                        indent + 1
                    );
                }
            }
        }
    }


    protected calculateConservativeDirtyInputCount(comp: Computation): number {
        let count = 0;
        for (const input of comp.runtimeInputs) {
            if (input.producer !== null && input.dirty) {
                count++;
            }
        }
        return count;
    }

    /**
     * 验证 dirtyInputCount 的正确性（开发时断言）
     */
    protected assertDirtyInputCount(comp: Computation, context: string, indent: number): void {
        if (!this.options.assertInvariants) {
            return; // 只在开发模式下验证
        }

        const conservativeCount = this.calculateConservativeDirtyInputCount(comp);
        if (comp.dirtyInputCount !== conservativeCount) {
            const errorMsg = `dirtyInputCount mismatch at ${context}: ` +
                `maintained=${comp.dirtyInputCount}, conservative=${conservativeCount}, ` +
                `comp=${comp.id}, runtimeInputs=[${Array.from(comp.runtimeInputs).map(v =>
                    `${v.id}(producer=${v.producer?.id ?? 'null'},dirty=${v.dirty})`
                ).join(', ')}]`;
            this.log('error', 'assertDirtyInputCount', errorMsg, indent);
            throw new Error(errorMsg);
        }
    }

    /**
     * 检查是否应跳过 computation（Visibility Pruning）
     */
    private shouldSkipVisibilityPruning(comp: Computation, indent: number): boolean {
        // If computation is running, we should not skip it (need to abort outdated tasks)
        if (comp.runningTask) {
            return false;
        }

        const shouldSkip = !comp.isRecursivelyObserved &&
            comp.outputs.size > 0 &&
            Array.from(comp.outputs.values()).every(o => !o.isRecursivelyObserved);

        if (shouldSkip) {
            this.isLogEnabled('trace') && this.log('trace', 'propagateCauseAtDownward',
                `Skipping ${comp.id} due to Visibility Pruning`,
                indent);
        }

        return shouldSkip;
    }

    /**
     * 尝试更新 dirtyInputCount（如果是新 dirty 事件且变量是输入）
     */
    private tryIncrementDirtyInputCount(
        comp: Computation,
        sourceVariable: Variable | null,
        isNewDirty: boolean,
        indent: number
    ): void {
        if (!isNewDirty || !sourceVariable || !this.isInputOfComputation(sourceVariable, comp, indent)) {
            return;
        }

        // INV-C4: dirtyInputCount 只计数计算变量（源变量立即 clean，不计入）
        if (sourceVariable.producer !== null && sourceVariable.dirty) {
            comp.dirtyInputCount++;
            this.isLogEnabled('trace') && this.log('trace', 'propagateCauseAtDownward',
                `${comp.id}: dirtyInputCount++ = ${comp.dirtyInputCount} (due to ${sourceVariable.id})`,
                indent);

            // 验证 dirtyInputCount 的正确性
            this.assertDirtyInputCount(comp, `after increment (source: ${sourceVariable.id})`, indent);
        } else if (sourceVariable.producer === null) {
            if (this.options.logLevel === 'trace') {
                this.isLogEnabled('trace') && this.log('trace', 'propagateCauseAtDownward',
                    `${comp.id}: Source input ${sourceVariable.id} caused dirty, but not counted (it's clean)`,
                    indent);
            }
        }
    }

    private updateCauseAt(comp: Computation, newCauseAt: number, indent: number): void {
        const oldCauseAt = comp.cause_at;
        comp.cause_at = newCauseAt;  // ← setter 自动触发 checkAbortOnCauseAtChange

        this.isLogEnabled('trace') && this.log('trace', 'propagateCauseAtDownward',
            `${comp.id}: cause_at ${oldCauseAt} -> ${newCauseAt}`,
            indent);
    }

    /**
     * 更新所有 outputs 的 cause_at 和 dirty，并递归传播
     */
    private propagateToOutputs(comp: Computation, newCauseAt: number, indent: number): void {
        for (const output of comp.outputs.values()) {
            const wasOutputDirty = output.dirty;
            output.cause_at = comp.cause_at;
            output.dirty = true;

            this.isLogEnabled('trace') && this.log('trace', 'propagateCauseAtDownward',
                `${output.id}: cause_at -> ${output.cause_at}, dirty -> true`,
                indent);

            // 递归向下游传播
            const isOutputNewDirty = !wasOutputDirty;
            for (const downstreamComp of output.dependents) {
                this._propagateCauseAtDownward(
                    downstreamComp,
                    newCauseAt,
                    output,  // output 作为下游的 sourceVariable
                    isOutputNewDirty,
                    indent + 1
                );
            }
        }
    }

    // ========== Main Method (SLAP Refactored) ==========

    /**
     * 向下游递归传播 cause_at 和 dirty 状态（统一传播方法）
     *
     * 这是响应式系统的核心传播方法，负责维护所有相关不变量。
     *
     * 基于核心原则：cause_at 增加 ⇒ 有变化 ⇒ 必须标记 dirty ⇒ 可能触发调度
     * 契约：
     * - cause_at 单调递增（只更新为更大的值）
     * - cause_at 增加必然伴随 dirty 标记（不变量语义）
     * - 递归性：逐层向下传播，直到叶子节点
     * - Visibility Pruning：通过状态机制自然生效（observeCount=0 → Idle → 不调度）
     * - Aggressive Cancellation：通过 SPOT 原则自动处理
     *   * cause_at setter 自动检查并 abort 过期任务
     *   * dirty/observeCount/dirtyInputCount setter 触发状态转换 → 自动 abort
     * - INV-C2 保证：comp.cause_at = max(inputs.cause_at)
     * - INV-C4 保证：dirtyInputCount 正确计数
     */
    protected _propagateCauseAtDownward(
        comp: Computation,
        newCauseAt: number,
        sourceVariable: Variable | null,
        isNewDirty: boolean,
        indent: number
    ): void {
        // 1. 尝试更新 dirtyInputCount（钻石拓扑：即使 cause_at 不变，也需要更新计数）
        this.tryIncrementDirtyInputCount(comp, sourceVariable, isNewDirty, indent);

        // 2. 检查 cause_at 是否需要更新
        if (newCauseAt <= comp.cause_at) {
            return; // cause_at 不需要更新，提前返回
        }

        // 3. 更新 cause_at（通过 setter 自动触发 abort 检查 - SPOT 原则）
        this.updateCauseAt(comp, newCauseAt, indent);

        // 4. 标记 computation 为 dirty（总是标记，保持语义正确性）
        comp.dirty = true;

        // 5. 更新所有 outputs 并递归传播
        this.propagateToOutputs(comp, newCauseAt, indent);
    }

    protected abstract addToReadyQueue(comp: Computation): void;

}
