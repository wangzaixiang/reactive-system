import {Observer, Result, VariableId} from "./types";
import {Computation} from "./computation";

/**
 * Variable - 变量的内部表示
 *
 * SPOT 原则 (Variable Dirty 语义不变量)：
 *
 * dirty = true  ⇔  cause_at 增加了（输入变化事件发生，但值尚未确定）
 * dirty = false ⇔  值已确定（source: 立即确定；computed: 计算完成）
 *
 * 状态转换规则：
 * - clean → dirty：仅在 cause_at 单调递增时（通过 propagateCauseAtDownward）
 * - dirty → clean：值确定时
 *   - Source Variable: updateSource 后立即确定（跳过 dirty=true 状态）
 *   - Computed Variable: 计算完成后确定（updateOutputs 或 cleanOutputDirty）
 *
 * 重要：任何直接设置 dirty = true 的代码都应该伴随 cause_at 的增加！
 */
export class Variable {
    id: VariableId;
    result: Result<any>; // 存储最新计算结果
    value_at: number; // 值真正变化的逻辑时钟
    cause_at: number; // 输入变化导致需要重新计算的逻辑时钟
    dirty: boolean; // 是否需要重新计算（SPOT: dirty ⇔ cause_at 增加且值未确定）
    producer: Computation | null; // 产生该变量的 Computation
    dependents: Set<Computation>; // 依赖该变量的 Computations
    observers: Set<Observer>; // 观察该变量的回调
    
    // ✅ 标量字段（同步维护）
    observeCount: number = 0;

    // ✅ 基于 observeCount 的推导属性
    get isRecursivelyObserved(): boolean {
        return this.observeCount > 0;
    }

    constructor(
        id: VariableId,
        options: {
            result?: Result<any>;
            value_at?: number;
            cause_at?: number;
            dirty?: boolean;
            producer?: Computation | null;
            isRecursivelyObserved?: boolean; // deprecated option
        } = {}
    ) {
        this.id = id;
        this.result = options.result ?? { type: 'uninitialized' };
        this.value_at = options.value_at ?? 0;
        this.cause_at = options.cause_at ?? 0;
        this.dirty = options.dirty ?? false;
        this.producer = options.producer ?? null;
        this.dependents = new Set();
        this.observers = new Set();
        // observeCount initialized to 0
    }

    /**
     * INV-V1: Source Variable 永远 clean
     */
    assertSourceClean(): void {
        if (!this.producer && this.dirty) {
            throw new Error(`INV-V1 violated: Source ${this.id} is dirty`);
        }
    }

    /**
     * INV-V2: value_at 的有效性
     */
    assertInvariantV2(): void {
        if (this.value_at === 0 && this.result.type !== 'uninitialized') {
            // value_at = 0 是初始值，如果result不是uninitialized说明已经赋值了
            // 这在source variable初始化时是正常的，不应该抛错
        }
    }

    /**
     * 断言所有 Variable invariants
     */
    assertInvariants(): void {
        this.assertSourceClean();
        this.assertInvariantV2();
    }
}
