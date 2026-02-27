import {ReactiveModulePropagation} from "./module_propagation";
import {
    ReactiveModuleOptions, Result
} from "./types";
import {Computation, IReactiveModuleScheduler} from "./computation";
import {Variable} from "./variable";
import {AbortException} from "./errors";

export abstract class ReactiveModuleSchedule extends ReactiveModulePropagation implements IReactiveModuleScheduler {

    // 调度队列（由 scheduler 层使用）
    protected readyQueue: Computation[] = [];
    protected runningTasksCount: number = 0;
    protected scheduleScheduled: boolean = false;
    protected idleWaiters: Array<() => void> = [];

    protected constructor(options: ReactiveModuleOptions = {}) {
        super(options);
    }

    /**
     * 将 Computation 加入就绪队列并触发调度
     *
     * 实现 IReactiveModuleScheduler 接口，供 Computation 自动调度使用。
     *
     * 契约：
     * - 避免重复加入队列（检查队列 + 检查运行状态）
     * - 保证状态不变式：comp 要么在队列中，要么在 runningTask 上（互斥）
     * - 在下一个 macro task 中触发调度（避免同步递归调用）
     *
     * @param comp 需要调度的 Computation
     */
    public addToReadyQueue(comp: Computation): void {
        // 完整的重复检查：
        // 1. 不在队列中（避免队列内重复）
        // 2. 没有正在执行的任务（避免与运行状态冲突）
        // 这保证了状态不变式：comp 要么在队列中，要么在 runningTask 上（互斥）
        if (!this.readyQueue.includes(comp) && comp.runningTask === null) {
            this.readyQueue.push(comp);

            // 使用 macro task 延迟调度（避免同步递归调用）
            if (!this.scheduleScheduled) {
                this.scheduleScheduled = true;
                setTimeout(() => {
                    this.scheduleScheduled = false;
                    this._scheduleNext(0);
                }, 0);
            }
        }
    }

    /**
     * 当前是否处于可观测意义上的 idle 状态
     *
     * idle 判定：
     * - readyQueue 为空
     * - runningTasksCount 为 0
     * - 没有已安排但未执行的调度（scheduleScheduled=false）
     */
    public isIdle(): boolean {
        return this.readyQueue.length === 0
            && this.runningTasksCount === 0
            && this.scheduleScheduled === false;
    }

    /**
     * 等待系统进入 idle 状态
     */
    public async waitIdle(): Promise<void> {
        if (this.isIdle()) {
            return;
        }

        await new Promise<void>((resolve) => {
            this.idleWaiters.push(resolve);
        });
    }

    /**
     * 调度下一个可运行的 Computation
     *
     * caller:
     *  1. after an execution, check the tail of readyQueue
     *  2. addToReadyQueue
     *  3. withTransaction end
     */
    protected _scheduleNext(indent: number): void {
        this.isLogEnabled('trace') && this.log('trace', 'scheduleNext', `readyQueue=${this.readyQueue.length}, running=${this.runningTasksCount}/${this.options.maxConcurrent}`, indent);

        while (this.runningTasksCount < this.options.maxConcurrent && this.readyQueue.length > 0) {
            const comp = this.readyQueue.shift(); // FIFO
            if (!comp) continue;

            // 断言：源头已保证 runningTask === null（通过 addToReadyQueue 的完整检查） 如果这里触发，说明状态不变式被破坏了
            if (comp.runningTask !== null) {
                const errorMsg = `INVARIANT VIOLATION: comp ${comp.id} in readyQueue but runningTask !== null (taskId=${comp.runningTask.taskId})`;
                this.log('error', 'scheduleNext', errorMsg, indent);
                if (this.options.assertInvariants) {
                    throw new Error(errorMsg);
                }
                continue; // 防御性跳过
            }

            this.isLogEnabled('trace') && this.log('trace', 'scheduleNext', `dispatching ${comp.id}`, indent);

            // Need to implement shouldExecute(comp) later for Input Pruning
            // For now, assume it always executes if it's in the readyQueue
            this.runningTasksCount++;
            this._executeComputation(comp, indent + 1)
                .catch((error) => {
                    if (this.options.logLevel === 'error') {
                        const isAbort = error instanceof AbortException || (error instanceof DOMException && error.name === 'AbortError');

                        if (isAbort) {
                            console.error(`[${this.logicalClock}] ${comp.id} was aborted (expected): ${error.message}`);
                        } else {
                            console.error(`[${this.logicalClock}] Unexpected error in executeComputation for ${comp.id}:`, error);
                        }
                    }
                })
                .finally(() => {
                    this.runningTasksCount--;
                    this._scheduleNext(0); // Continue scheduling, reset indent
                });
        }

        this.checkIdle();
    }

    protected checkIdle(): void {
        if (!this.isIdle()) {
            return;
        }
        if (this.idleWaiters.length === 0) {
            return;
        }
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const resolve of waiters) {
            resolve();
        }
    }

    // -------------------------------------------------------------------------
    // 公共 API (Public API) - 数据变更接口
    // -------------------------------------------------------------------------

    /**
     * 批量事务（简化为便利函数）
     */
    async withTransaction(fn: () => void | Promise<void>): Promise<void> {
        await fn();
    }

    protected checkAbortSignal(signal?: AbortSignal): void {
        if (signal?.aborted) {
            throw new AbortException('Task was aborted');
        }
    }

    /**
     * 清理 Computation 的输出变量的 dirty 状态
     * 当 Computation 被跳过执行时调用 (e.g., Input Pruning)
     * @param comp 需要清理输出的 Computation
     */
    protected abstract _executeComputation(comp: Computation, indent: number, parentSignal?: AbortSignal ): Promise<void>;
    protected abstract _evaluate(variable: Variable, indent: number, signal?: AbortSignal, ): Promise<Result<any>>;

}
