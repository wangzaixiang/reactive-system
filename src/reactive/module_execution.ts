import {ReactiveModuleSchedule} from "./module_schedule";
import {ComputationState, ReactiveModuleOptions, Result, RunningTask, Scope, VariableId} from "./types";
import {Computation} from "./computation";
import {Variable} from "./variable";
import {deepEqual} from "./utils";
import {UninitializedError, AbortException} from "./errors";

export abstract class ReactiveModuleExecution extends ReactiveModuleSchedule {

    protected taskIdCounter: number = 0; // 任务 ID 计数器

    protected constructor(options: ReactiveModuleOptions = {}) {
        super(options);
    }

    // public API for getValue
    public async getValue(id: VariableId): Promise<any> {
        return this._getValue(id, 0);
    }

    private async _getValue(id: VariableId, indent: number): Promise<any> {
        const variable = this._getVariable(id, indent + 1);
        const result = await this._evaluate(variable, indent+1);
        if (result.type === 'error') throw result.error;
        if (result.type === 'fatal') throw result.error; // Should probably wrap or handle specifically
        if (result.type === 'uninitialized') throw new UninitializedError();
        return result.value;
    }

    /**
     * 执行一个 Computation
     *
     * 契约：
     * - 守卫保证：同一 Computation 最多只有一个 task 在执行
     * - Immediate 模式：abort 旧任务，等待清理完成，启动新任务
     * - Deferred 模式：等待旧任务完成，复用结果，不启动新任务
     * - Input Pruning: 如果输入未真正变化，跳过执行
     * - 动态依赖追踪：记录实际访问的变量
     * - AbortError 不传播到输出（其他错误传播）
     * - 执行后如果仍 dirty，重新调度
     *
     */
    protected async _executeComputation(comp: Computation, indent: number, parentSignal?: AbortSignal): Promise<void> {
        // ========== 守卫检查 1: 状态必须是 Ready，observeCount > 0 ==========
        // 在 ReadyQueue 中的 computation 可能在调度前再次发生变化，例如不再被观察
        if (comp.state !== ComputationState.Ready || comp.observeCount === 0) {
            this.isLogEnabled('debug') && this.log('debug', 'executeComputation',
                `${comp.id} guard check failed: state=${comp.state}, observeCount=${comp.observeCount}, skipping execution`, indent);
            return;
        }

        const taskId = ++this.taskIdCounter;
        this.isLogEnabled('debug') && this.log('debug', 'executeComputation', `task:${taskId} computation:${comp.id} starting (state=${comp.state}, dirtyInputCount=${comp.dirtyInputCount}, input_version=${comp.input_version})`, indent);

        if (this.maybeSkipExecution(comp, indent + 1)) {
            return;
        }

        const { abortController, taskPromiseResolve, taskPromiseReject } =
            this.setupExecutionTask(comp, taskId, parentSignal, indent + 1);

        // 保存 task 引用，用于 finally 清理
        const task = comp.runningTask!;

        const accessedVariables = new Set<Variable>();
        const scope = this.createScopeProxy(comp, abortController, accessedVariables, indent + 1);

        try {
            const outputs = await comp.body(scope, abortController.signal);
            this.checkAbortSignal(abortController.signal);

            this.handleExecutionSuccess(comp, outputs, accessedVariables, taskPromiseResolve, taskId, indent + 1);
        } catch (error) {
            this.handleExecutionError(comp, error, taskPromiseReject, taskId, indent + 1);
        } finally {
            this.handleExecutionFinally(comp, task, indent + 1);
        }
    }

    private isAbortError(error: any): boolean {
        // 检查我们自己的 AbortException
        if (error instanceof AbortException) {
            return true;
        }
        // 检查系统的 DOMException AbortError（由 AbortSignal 抛出）
        return error instanceof DOMException && error.name === 'AbortError';

    }

    /**
     * 检查是否应该跳过执行（Input Pruning）
     */
    private maybeSkipExecution(comp: Computation, indent: number): boolean {
        const shouldRun = this.shouldExecute(comp, indent);
        this.isLogEnabled('trace') && this.log('trace', 'shouldExecute', `${comp.id} -> ${shouldRun} (input_version=${comp.input_version}, runtimeInputs=${comp.runtimeInputs.size})`, indent);

        if (!shouldRun) { // skip the computation
            this.cleanOutputDirty(comp, indent + 1);
            comp.dirty = false; // state 会自动变为 Idle
            this.isLogEnabled('debug') && this.log('debug', 'executeComputation', `${comp.id} SKIPPED (Input Pruning)`, indent);
            return true;
        }

        return false; // not skip
    }


    private shouldExecute(comp: Computation, _indent: number): boolean {
        // First execution: input_version is 0 (never executed before)
        if (comp.input_version === 0) {
            return true;
        }

        const currentMaxInputVersion = this.getMaxInputVersion(comp.runtimeInputs);

        // If the current max input version is greater than the last executed version, then re-execute.
        // This handles cases where input values truly changed.
        return currentMaxInputVersion > comp.input_version;
    }

    private setupExecutionTask(comp: Computation, taskId: number, parentSignal?: AbortSignal, _indent?: number): {
        abortController: AbortController;
        taskPromise: Promise<any>;
        taskPromiseResolve: (value: any) => void;
        taskPromiseReject: (reason?: any) => void;
    } {
        const abortController = new AbortController();
        if (parentSignal) {
            parentSignal.addEventListener('abort', () => abortController.abort());
        }

        let taskPromiseResolve: (value: any) => void;
        let taskPromiseReject: (reason?: any) => void;
        const taskPromise = new Promise<any>((resolve, reject) => {
            taskPromiseResolve = resolve;
            taskPromiseReject = reject;
        });

        // Add default error handler to prevent unhandled rejection
        // This is important for push-based scheduling where no one awaits the promise
        taskPromise.catch(() => {
            // Errors are already handled in handleExecutionError
            // This catch is just to prevent unhandled rejection warnings
        });

        comp.runningTask = {
            taskId: taskId,
            cause_at: comp.cause_at,
            abortController: abortController,
            promise: taskPromise,
        };
        // state 现在是纯函数，会自动根据 runningTask !== null 计算为 Running

        return { abortController, taskPromise, taskPromiseResolve: taskPromiseResolve!, taskPromiseReject: taskPromiseReject! };
    }


    /**
     * 创建 Scope 代理用于动态依赖追踪
     */
    private createScopeProxy(
        comp: Computation,
        abortController: AbortController,
        accessedVariables: Set<Variable>,
        indent: number
    ): Scope {
        return new Proxy({} as Scope, {
            get: async (_target, prop) => {
                const variableId = prop as VariableId;

                // 框架内部 API：__ 前缀
                if (variableId === '__getResult') {
                    return this.scopeGetResult(comp, abortController, accessedVariables, indent + 1);
                }

                // 用户变量访问：无前缀
                return this.scopeGetter(comp, variableId, abortController, accessedVariables, indent + 1);
            },
        });
    }

    private handleExecutionSuccess(
        comp: Computation,
        outputs: Record<string, any>,
        accessedVariables: Set<Variable>,
        taskPromiseResolve: (value: any) => void,
        taskId: number,
        indent: number
    ): void {
        this.isLogEnabled('debug') && this.log('debug', 'executeComputation', `task:${taskId} computation:${comp.id} completed (outputs=${Object.keys(outputs).join(', ')})`, indent);

        this.updateOutputs(comp, outputs, indent + 1);
        this.cleanUnusedInputs(comp, accessedVariables, indent + 1);

        comp.dirty = false; // state 会自动变为 Idle
        comp.input_version = this.getMaxInputVersion(comp.runtimeInputs);
        this.isLogEnabled('trace') && this.log('trace', 'handleExecutionSuccess', `${comp.id} state set to ${comp.state}, dirty=${comp.dirty}`, indent);
        taskPromiseResolve(undefined);
    }


    private handleExecutionError(comp: Computation, error: any, taskPromiseReject: (reason?: any) => void, taskId: number, indent: number): void {
        if (this.isAbortError(error)) {
            // AbortException 是预期的取消操作，不记录堆栈
            this.isLogEnabled('debug') && this.log('debug', 'executeComputation',
                `task:${taskId} computation:${comp.id} aborted (AbortException: task was cancelled)`,
                indent);
            // Don't propagate abort errors to computation outputs
            // Keep computation dirty for potential retry
        } else {
            // 真正的错误：记录完整信息（包括堆栈）
            const errorMessage = error instanceof Error
                ? `${error.message}\n${error.stack}`
                : String(error);
            this.log('error', 'executeComputation',
                `task:${taskId} computation:${comp.id} failed: ${errorMessage}`,
                indent);
            this.updateOutputsWithError(comp, error, indent + 1);

            // 错误也是一种完成状态，需要清理 computation 状态
            comp.dirty = false; // state 会自动变为 Idle
            comp.input_version = this.getMaxInputVersion(comp.runtimeInputs);
            this.isLogEnabled('trace') && this.log('trace', 'handleExecutionError', `${comp.id} state set to ${comp.state}, dirty=${comp.dirty}`, indent);
        }
        taskPromiseReject(error);

        throw error;
    }


    private handleExecutionFinally(comp: Computation, task: RunningTask, indent: number): void {
        this.isLogEnabled('trace') && this.log('trace', 'handleExecutionFinally', `${comp.id} task:${task.taskId} entered. dirty=${comp.dirty}, state=${comp.state}`, indent);

        // 1. 清理执行状态
        if (comp.runningTask?.taskId === task.taskId) {
            // 正常完成（未被 abort）
            comp.runningTask = null;
            this.isLogEnabled('trace') && this.log('trace', 'handleExecutionFinally', `${comp.id} task:${task.taskId} completed normally, cleared runningTask`, indent);
        } else {
            // 被 abort 了，从 abortingTasks 中移除
            comp.abortingTasks.delete(task);
            this.isLogEnabled('trace') && this.log('trace', 'handleExecutionFinally', `${comp.id} task:${task.taskId} was aborted, removed from abortingTasks (remaining: ${comp.abortingTasks.size})`, indent);
        }

        if (comp.dirty) {
            // Re-evaluate cause_at to ensure consistency before re-scheduling
            // This is crucial if inputs updated while running
            if (comp.runtimeInputs.size > 0) {
                 const maxInputCauseAt = Math.max(...Array.from(comp.runtimeInputs).map(v => v.cause_at));
                 if (this.options.logLevel === 'trace') {
                     this.isLogEnabled('trace') && this.log('trace', 'handleExecutionFinally', `Re-evaluating cause_at. current=${comp.cause_at}, maxInput=${maxInputCauseAt}`, indent);
                 }
                 if (maxInputCauseAt > comp.cause_at) {
                     comp.cause_at = maxInputCauseAt;
                     // Also update outputs cause_at to maintain consistency
                     for (const output of comp.outputs.values()) {
                         output.cause_at = comp.cause_at;
                     }
                     if (this.options.logLevel === 'trace') {
                         this.isLogEnabled('trace') && this.log('trace', 'handleExecutionFinally', `Updated comp.cause_at to ${comp.cause_at}`, indent);
                     }
                 }
            }
            // Note: In immediate abort mode, a new task may have started while the old task's
            // finally block is running, so runningTask may not be null even though the comp is dirty.
            // This is expected behavior. Only check if runningTask is null.
            if( this.options.assertInvariants && comp.runningTask === null ){
                if(comp.state !== ComputationState.Idle){
                    this.log('error', 'handleExecutionFinally', `${comp.id} is dirty but state is ${comp.state}, expected Idle`, indent);
                }
            }
        } else {
            this.isLogEnabled('trace') &&  this.log('trace', 'handleExecutionFinally', `${comp.id} is clean. Final state=${comp.state}`, indent);
        }
        
        // Assertions here
        if (this.options.assertInvariants) {
            try {
                comp.assertInvariants();
                comp.outputs.forEach(v => v.assertInvariants());
            } catch (e) {
                this.log('error', 'assertInvariants', `${comp.id} failed invariants: ${e}`, indent);
                throw e; // Re-throw to fail test
            }
        }
    }


    /**
     * 更新 Computation 的输出变量，并应用 Output Pruning
     *
     * 契约：
     * - 逻辑时钟最多递增一次（即使多个输出变化）
     * - Output Pruning：只有值真正变化才更新 value_at
     * - 所有变化的输出共享同一 value_at（满足原子性）
     */
    private updateOutputs(comp: Computation, newOutputs: Record<string, any>, indent: number): void {
        // 第一遍：检查是否有任何输出值变化
        let hasValueChange = false;
        comp.outputs.forEach((outputVar, id) => {
            const oldValue = outputVar.result.type === 'success' ? outputVar.result.value : undefined;
            if (!deepEqual(oldValue, newOutputs[id])) {
                hasValueChange = true;
            }
        });

        // 如果有变化，递增逻辑时钟一次
        const newValueAt = hasValueChange ? this.nextLogicalClock() : 0;

        // 第二遍：更新所有输出变量
        comp.outputs.forEach((outputVar, id) => {
            const newResult: Result<any> = { type: 'success', value: newOutputs[id] };
            const oldValue = outputVar.result.type === 'success' ? outputVar.result.value : undefined;
            const valueChanged = !deepEqual(oldValue, newOutputs[id]);

            // Output Pruning: 仅当值真正变化时才更新 value_at
            if (valueChanged) {
                outputVar.result = newResult;
                outputVar.value_at = newValueAt; // 所有变化的输出共享同一时钟
                if (this.options.logLevel === 'trace') {
                    this.isLogEnabled('trace') && this.log('trace', 'updateOutputs', `Output ${outputVar.id} changed. value_at: ${outputVar.value_at}`, indent);
                }
            } else {
                // If value didn't change, value_at remains the same
                if (this.options.logLevel === 'trace') {
                    this.isLogEnabled('trace') && this.log('trace', 'updateOutputs', `Output ${outputVar.id} unchanged. value_at remains ${outputVar.value_at}`, indent);
                }
            }

            outputVar.cause_at = comp.cause_at; // Output's cause_at tracks its producer's cause_at
            outputVar.dirty = false; // Output is now clean

            this._cleanVariable(outputVar, indent + 1); // Cascade clean to downstream
        });
    }


    /**
     * 处理 scope.__getResult() 调用（内部 API）
     *
     * 契约：
     * - 检查 abort signal，如果已中止则抛出 AbortException
     * - 返回函数用于获取变量的完整 Result 对象
     * - 先 evaluate 等待变量变为 clean，再追踪访问（避免增加 dirtyInputCount）
     */
    private scopeGetResult(
        comp: Computation,
        abortController: AbortController,
        accessedVariables: Set<Variable>,
        indent: number
    ): (id: VariableId) => Promise<Result<any>> {
        return async (id: VariableId) => {
            // 1. 检查 abort signal（及早退出）
            this.checkAbortSignal(abortController.signal);

            // 2. 获取变量
            const variable = this._getVariable(id, indent + 1);

            // 3. 先计算变量（等待变为 clean）
            const result = await this._evaluate(variable, indent + 1, abortController.signal);

            // 4. 再追踪访问（此时 variable 已 clean，不会增加 dirtyInputCount）
            this.trackVariableAccess(comp, variable, abortController, accessedVariables, indent + 1);

            // 5. 返回 Result
            return result;
        };
    }

    /**
     * 处理直接变量访问（scope.variableId）
     *
     * 契约：
     * - 检查 abort signal，如果已中止则抛出 AbortException
     * - 先 evaluate 等待变量变为 clean，再追踪访问（避免增加 dirtyInputCount）
     * - 等待变量变为 clean 并返回值
     * - 如果 Result 是 error，抛出错误
     * - 如果 Result 是 uninitialized，抛出 UninitializedError
     *
     * 注意：需要检查 variable 在 staticInputs 中，否则可能会导致循环依赖。
     * 未来考虑在 Computation 中设置是否容许动态依赖。
     * 使用动态依赖的语义需要强调：在 runtimeInputs 不发生变化的时候，computation 逻辑上必须 pure。
     */
    private async scopeGetter(
        comp: Computation,
        variableId: VariableId,
        abortController: AbortController,
        accessedVariables: Set<Variable>,
        indent: number
    ): Promise<any> {
        // 1. 检查 abort signal（及早退出）
        this.checkAbortSignal(abortController.signal);

        // 2. 获取变量
        const variable = this._getVariable(variableId, indent + 1);

        // 3. 先计算变量（等待变为 clean）
        const result = await this._evaluate(variable, indent+1, abortController.signal);

        // 4. 再追踪访问（此时 variable 已 clean，不会增加 dirtyInputCount）
        this.trackVariableAccess(comp, variable, abortController, accessedVariables, indent + 1);

        // 5. 返回值
        if (result.type === 'error') {
            throw result.error;
        }
        else if (result.type === 'fatal') {
            throw result.error;
        }
        else if (result.type == 'uninitialized') {
            throw new UninitializedError();
        }
        else {
            return result.value;
        }
    }

    private cleanUnusedInputs(comp: Computation, accessedVariables: Set<Variable>, indent: number): void {
        const toRemove: Variable[] = [];
        for (const input of comp.runtimeInputs) {
            if (!accessedVariables.has(input)) {
                toRemove.push(input);
            }
        }
        toRemove.forEach(input => {
            // 1. Remove dependencies
            comp.runtimeInputs.delete(input);
            input.dependents.delete(comp);

            // 2. Propagate observeCount downward (cleanup)
            if (comp.observeCount > 0) {
                this._propagateObserveCountUpward(input, -comp.observeCount, indent + 1);
            }

            // 3. Update dirtyInputCount
            if (input.dirty && input.producer !== null) {
                comp.dirtyInputCount--;
            }
            if (this.options.logLevel === 'trace') {
                this.isLogEnabled('trace') && this.log('trace', 'cleanUnusedInputs', `Removed unused runtime input ${input.id} from Computation ${comp.id}`, indent);
            }
        });

        // Verify dirtyInputCount after cleanup
        // 验证 dirtyInputCount 的正确性（在清理未使用输入后）
        this.assertDirtyInputCount(comp, 'after cleanUnusedInputs', indent);
    }

    private updateOutputsWithError(comp: Computation, error: any, indent: number): void {
        if (this.options.logLevel === 'error') {
            this.log('error', 'updateOutputsWithError', `Propagating error from Computation ${comp.id}: ${error}`, indent);
        }
        comp.outputs.forEach(outputVar => {
            outputVar.result = { type: 'error', error: error };
            outputVar.value_at = this.nextLogicalClock(); // Mark new value_at for error
            outputVar.cause_at = comp.cause_at;
            outputVar.dirty = false; // Error result is still a valid result
            this._cleanVariable(outputVar, indent + 1); // Cascade clean to downstream
        });
    }

    /**
     * 追踪变量访问（用于动态依赖）
     *
     * 契约：
     * - 检查 abort signal，如果已中止则抛出异常
     * - 动态依赖场景：预先更新 cause_at 以避免 spurious abort
     * - 建立依赖关系并传播状态变化
     */
    private trackVariableAccess(
        comp: Computation,
        variable: Variable,
        abortController: AbortController,
        accessedVariables: Set<Variable>,
        indent: number
    ): void {
        accessedVariables.add(variable);

        if (!comp.runtimeInputs.has(variable)) {
            // 0. 检查 abort signal（及早退出）
            this.checkAbortSignal(abortController.signal);

            // INV-C1: runtimeInputs ⊆ staticInputs
            // Dynamic dependency must be declared in staticInputs
            if (!comp.staticInputs.has(variable.id)) {
                throw new Error(`Variable ${variable.id} not in staticInputs of ${comp.id}`);
            }

            // 动态依赖场景：预先更新 runningTask.cause_at 以避免 spurious abort
            // 关键：只更新 task.cause_at，不更新 comp.cause_at
            // 这样后续传播会正常更新 comp 和 outputs，但不会触发 abort
            if (variable.cause_at > comp.cause_at && comp.runningTask) {
                comp.runningTask.cause_at = variable.cause_at;
                this.isLogEnabled('trace') && this.log('trace', 'trackVariableAccess',
                    `Dynamic dependency: pre-updated task.cause_at to ${variable.cause_at} (comp.cause_at=${comp.cause_at})`,
                    indent);
            }

            // 1. Establish dependency
            comp.runtimeInputs.add(variable);
            variable.dependents.add(comp);

            // 2. Propagate observeCount upward
            if (comp.observeCount > 0) {
                this._propagateObserveCountUpward(variable, comp.observeCount, indent + 1);
            }

            // 3. Propagate cause_at and dirty downward (if needed)
            // 注意：由于上面已预更新 task.cause_at，传播会更新 comp.cause_at
            // 但 checkAbortOnCauseAtChange 检查时发现 taskCauseAt >= newCauseAt，不会 abort
            if (variable.cause_at > comp.cause_at) {
                this._propagateCauseAtDownward(comp, variable.cause_at, variable, false, indent + 1);
            }

            // 4. Update dirtyInputCount
            if (variable.dirty) {
                comp.dirtyInputCount++;
            }
        }
    }


    /**
     * 拉取计算：按需递归计算变量的值
     *
     * 契约：
     * - 如果变量 clean，立即返回 result
     * - Source variable 不应该 dirty（updateSource 会立即 clean）
     * - 重试 AbortError 直到成功或非 Abort 错误
     * - 非 AbortError 直接抛出
     */
    protected async evaluate(variable: Variable, signal?: AbortSignal): Promise<Result<any>> {
        return this._evaluate(variable, 0, signal);
    }

    protected async _evaluate(variable: Variable, indent:number, signal?: AbortSignal): Promise<Result<any>> {
        // 1. Fast path: clean variable AND observed (if unobserved, it might be stale due to pruning)
        if (!variable.dirty) {
            this.isLogEnabled('trace') && this.log('trace', 'evaluate', `${variable.id} is clean and observed, returning result`, indent);
            return variable.result;
        }

        // 2. Source variable logic
        if (variable.producer === null) {
            this.isLogEnabled('trace') && this.log('trace', 'evaluate', `${variable.id} is source variable, handling`, indent);
            return variable.result;
        }

        this.isLogEnabled('trace') && this.log('trace', 'evaluate', `${variable.id} is dirty, waiting via observe`, indent);

        // 3. Temporary observe
        return this.waitForVariableViaObserve(variable, signal, indent);
    }

    /**
     * 通过临时观察等待变量变为 clean
     */
    private waitForVariableViaObserve(variable: Variable, signal: AbortSignal | undefined, indent: number): Promise<Result<any>> {
        return new Promise<Result<any>>((resolve, reject) => {
            let unsubscribe: (() => void) | null = null;

            const abortHandler = () => {
                if (unsubscribe) {
                    unsubscribe();
                }
                reject(new AbortException('Evaluation was aborted'));
            };

            // 检查 signal 是否已中止
            if (signal) {
                if (signal.aborted) {
                    reject(new AbortException('Evaluation was aborted'));
                    return;
                }
                signal.addEventListener('abort', abortHandler);
            }

            // _observe will propagate count and schedule producer if needed
            unsubscribe = this._observe(variable.id, (result) => {
                // Only resolve if the variable is no longer dirty.
                // This ensures we wait for computation to complete or for a structural error (fatal) to be set.
                if (!variable.dirty) {
                    if (signal) {
                        signal.removeEventListener('abort', abortHandler);
                    }

                    // Immediately unsubscribe (auto-cleanup observeCount)
                    if (unsubscribe) unsubscribe();

                    this.isLogEnabled('trace') && this.log('trace', 'evaluate', `${variable.id} observed clean result`, indent);
                    resolve(result);
                }
            }, indent + 1);
        });
    }

}
