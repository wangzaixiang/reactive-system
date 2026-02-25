import { describe, it, expect, beforeEach } from 'vitest';
import { ReactiveModule } from '../../src/reactive/reactive_module';
import { ComputationState, VariableId } from '../../src/reactive/types';
import {createReactiveModule} from "./utils";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Abort 测试 - 基于 SPOT 原则
 *
 * 测试重点：
 * - 验证核心语义（最终结果、状态一致性）
 * - 不验证实现细节（abort 调用次数）
 */
describe('Abort Dynamic dependencies', () => {
    let system: ReactiveModule;

    beforeEach(() => {
        system = createReactiveModule({assertInvariants: true, abortStrategy: 'immediate'});
    });


    it('B2.4: Single update during dynamic access - should NOT abort', async () => {
        // Setup: X ? A : B + C
        // Timeline:
        // t0: X=false, start execution
        // t1: update b → B dirty → comp accesses B → cause_at synced → no abort
        // t2: access C, no new update
        // Result: it = 11 + 20 (no abort)

        system.defineSource({id: 'X' as VariableId, initialValue: true});
        system.defineSource({id: 'A' as VariableId, initialValue: 1});
        system.defineSource({id: 'b' as VariableId, initialValue: 10});
        system.defineSource({id: 'c' as VariableId, initialValue: 20});

        // B depends on b
        system.defineComputation({
            id: 'comp_B',
            inputs: ['b' as VariableId],
            outputs: ['B' as VariableId],
            body: async (scope) => {
                const b = await scope.b;
                return {B: b};
            },
        });

        // C depends on c
        system.defineComputation({
            id: 'comp_C',
            inputs: ['c' as VariableId],
            outputs: ['C' as VariableId],
            body: async (scope) => {
                const c = await scope.c;
                return {C: c};
            },
        });

        let executionCount = 0;
        const completedResults: number[] = [];

        // it = X ? A : B + C
        // NOTE: B and C ARE in inputs list, but accessed dynamically based on X
        // Dynamic: accessed conditionally at runtime, not always used
        system.defineComputation({
            id: 'comp_it',
            inputs: ['X' as VariableId, 'A' as VariableId, 'B' as VariableId, 'C' as VariableId],
            outputs: ['it' as VariableId],
            body: async (scope, signal) => {
                executionCount++;
                const X = await scope.X;

                if (X) {
                    const A = await scope.A;
                    if (!signal.aborted) completedResults.push(A);
                    return {it: A};
                } else {
                    // Dynamic branch: B + C (accessed dynamically, not in static inputs)
                    await delay(50); // t1: delay before accessing B

                    if (signal.aborted) return {it: -1};

                    const B = await scope.B; // Dynamic access to B

                    await delay(50); // t2: delay before accessing C

                    if (signal.aborted) return {it: -1};

                    const C = await scope.C; // Dynamic access to C
                    const result = B + C;

                    if (!signal.aborted) completedResults.push(result);
                    return {it: result};
                }
            },
        });

        const results: any[] = [];
        system.observe('it' as VariableId, (result) => {
            if (result.type === 'success') {
                results.push(result.value);
            }
        });

        await delay(50);

        // First execution: X=true → A=1
        expect(results).toEqual([1]);

        // Change X to false, trigger dynamic branch
        system.updateSource('X' as VariableId, false);

        await delay(30); // Execution started, in first delay(50)

        // t1: Update b while comp is in delay before accessing B
        system.updateSource('b' as VariableId, 11);

        await delay(150); // Wait for completion

        // ✅ 核心验证：单次更新期间的动态访问不应 abort
        expect(executionCount).toBe(2); // Only 2 executions (initial + changed X, no abort)
        expect(completedResults).toEqual([1, 31]); // 11 + 20 = 31
        expect(results[results.length - 1]).toBe(31);

        const comp = system.peekComputation('comp_it');
        expect(comp.runningTask).toBeNull();
        expect(comp.state).toBe(ComputationState.Idle);
    });

    it('B2.5: Multiple updates during dynamic access - SHOULD abort', async () => {
        // Setup: X ? A : B + C
        // Timeline:
        // t0: X=false, start execution
        // t1: update b → B dirty → comp accesses B → cause_at synced to t1
        // t2: update b again → comp.cause_at becomes t2 → task.cause_at (t1) < comp.cause_at (t2) → abort!
        // Result: retry, it = 12 + 20 (with abort)

        system.defineSource({id: 'X' as VariableId, initialValue: true});
        system.defineSource({id: 'A' as VariableId, initialValue: 1});
        system.defineSource({id: 'b' as VariableId, initialValue: 10});
        system.defineSource({id: 'c' as VariableId, initialValue: 20});

        // B depends on b
        system.defineComputation({
            id: 'comp_B',
            inputs: ['b' as VariableId],
            outputs: ['B' as VariableId],
            body: async (scope) => {
                const b = await scope.b;
                return {B: b};
            },
        });

        // C depends on c
        system.defineComputation({
            id: 'comp_C',
            inputs: ['c' as VariableId],
            outputs: ['C' as VariableId],
            body: async (scope) => {
                const c = await scope.c;
                return {C: c};
            },
        });

        let executionCount = 0;
        const completedResults: number[] = [];

        // it = X ? A : B + C
        // NOTE: B and C ARE in inputs list, but accessed dynamically based on X
        // Dynamic: accessed conditionally at runtime, not always used
        system.defineComputation({
            id: 'comp_it',
            inputs: ['X' as VariableId, 'A' as VariableId, 'B' as VariableId, 'C' as VariableId],
            outputs: ['it' as VariableId],
            body: async (scope, signal) => {
                executionCount++;
                const X = await scope.X;

                if (X) {
                    const A = await scope.A;
                    if (!signal.aborted) completedResults.push(A);
                    return {it: A};
                } else {
                    // Dynamic branch: B + C (accessed dynamically, not in static inputs)
                    await delay(50); // t1: delay before accessing B

                    if (signal.aborted) return {it: -1};

                    const B = await scope.B; // Dynamic access to B

                    await delay(50); // t2: delay before accessing C

                    if (signal.aborted) return {it: -1};

                    const C = await scope.C; // Dynamic access to C
                    const result = B + C;

                    if (!signal.aborted) completedResults.push(result);
                    return {it: result};
                }
            },
        });

        const results: any[] = [];
        system.observe('it' as VariableId, (result) => {
            if (result.type === 'success') {
                results.push(result.value);
            }
        });

        await delay(50);

        // First execution: X=true → A=1
        expect(results).toEqual([1]);

        // Change X to false, trigger dynamic branch
        system.updateSource('X' as VariableId, false);

        await delay(30); // Execution started, in first delay(50)

        // t1: Update b (first time)
        system.updateSource('b' as VariableId, 11);

        await delay(60); // Comp accessed B, now in second delay(50)

        // t2: Update b (second time) → this should trigger abort
        system.updateSource('b' as VariableId, 12);

        await delay(200); // Wait for abort + retry + completion

        // ✅ 核心验证：多次更新导致 abort
        expect(executionCount).toBeGreaterThanOrEqual(3); // initial + aborted + retry
        expect(results[results.length - 1]).toBe(32); // 12 + 20 = 32 (latest value)

        const comp = system.peekComputation('comp_it');
        expect(comp.runningTask).toBeNull();
        expect(comp.state).toBe(ComputationState.Idle);
    });
});

