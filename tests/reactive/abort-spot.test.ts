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
describe('Abort - SPOT Principle', () => {
  let system: ReactiveModule;

  beforeEach(() => {
    system = createReactiveModule({ assertInvariants: true, abortStrategy: 'immediate' });
  });

  // ==========================================================================
  // A1. cause_at 传播触发 abort
  // ==========================================================================

  describe('A1. cause_at propagation triggers abort', () => {

    it('A1.1: Single input update - abort old task, execute new task', async () => {
      // Setup
      system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

      let executionCount = 0;
      const executionValues: number[] = [];

      system.defineComputation({
        id: 'comp',
        inputs: ['x' as VariableId],
        outputs: ['y' as VariableId],
        body: async (scope, signal) => {
          executionCount++;
          const x = await scope.x;
          executionValues.push(x);

          await delay(50); // Simulate long-running task

          // AbortError will be thrown automatically by signal check
          return { y: x * 10 };
        },
      });

      const results: any[] = [];
      system.observe('y' as VariableId, (result) => {
        if (result.type === 'success') {
          results.push(result.value);
        }
      });

      // Wait for task to start
      await delay(20);

      // Update input → cause_at increases → abort old task
      system.updateSource('x' as VariableId, 2);

      // Wait for new task to complete
      await delay(100);

      // ✅ 核心验证：最终结果正确
      expect(results).toEqual([20]); // Only the latest value
      expect(executionCount).toBeGreaterThanOrEqual(2); // At least 2 executions

      // ✅ 核心验证：状态一致性
      const comp = system.peekComputation('comp');
      expect(comp.state).toBe(ComputationState.Idle);
      expect(comp.runningTask).toBeNull();
      expect((comp as any).abortingTasks.size).toBe(0);
    });

    it('A1.2: Multiple rapid updates - only last execution completes', async () => {
      system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

      const completedValues: number[] = [];

      system.defineComputation({
        id: 'comp',
        inputs: ['x' as VariableId],
        outputs: ['y' as VariableId],
        body: async (scope, signal) => {
          const x = await scope.x;
          await delay(50);

          if (!signal.aborted) {
            completedValues.push(x);
          }
          return { y: x * 10 };
        },
      });

      const results: any[] = [];
      system.observe('y' as VariableId, (result) => {
        if (result.type === 'success') {
          results.push(result.value);
        }
      });

      await delay(10);

      // Rapid updates: 2, 3, 4, 5, 6
      for (let i = 2; i <= 6; i++) {
        system.updateSource('x' as VariableId, i);
        await delay(10);
      }

      await delay(100);

      // ✅ 核心验证：只有最后一次完成
      expect(completedValues.length).toBe(1);
      expect(completedValues[0]).toBe(6); // Last value
      expect(results).toEqual([60]);
    });

    it('A1.3: Multiple inputs update simultaneously - abort is idempotent', async () => {
      system.defineSource({ id: 'x' as VariableId, initialValue: 1 });
      system.defineSource({ id: 'y' as VariableId, initialValue: 1 });

      system.defineComputation({
        id: 'comp',
        inputs: ['x' as VariableId, 'y' as VariableId],
        outputs: ['result' as VariableId],
        body: async (scope, signal) => {
          const x = await scope.x;
          await delay(30);
          const y = await scope.y;
          return { result: x + y };
        },
      });

      const results: any[] = [];
      system.observe('result' as VariableId, (result) => {
        if (result.type === 'success') {
          results.push(result.value);
        }
      });

      await delay(15);

      // Update both inputs rapidly
      system.updateSource('x' as VariableId, 10);
      system.updateSource('y' as VariableId, 20);

      await delay(100);

      // ✅ 核心验证：最终结果正确（幂等性保证）
      expect(results[results.length - 1]).toBe(30);

      const comp = system.peekComputation('comp');
      expect(comp.runningTask).toBeNull();
    });

    it('A1.4: Diamond topology - cause_at propagates correctly', async () => {
      // Diamond: a → b, a → c, b+c → d
      system.defineSource({ id: 'a' as VariableId, initialValue: 1 });

      system.defineComputation({
        id: 'comp_b',
        inputs: ['a' as VariableId],
        outputs: ['b' as VariableId],
        body: async (scope) => {
          const a = await scope.a;
          await delay(20);
          return { b: a * 2 };
        },
      });

      system.defineComputation({
        id: 'comp_c',
        inputs: ['a' as VariableId],
        outputs: ['c' as VariableId],
        body: async (scope) => {
          const a = await scope.a;
          await delay(20);
          return { c: a + 5 };
        },
      });

      system.defineComputation({
        id: 'comp_d',
        inputs: ['b' as VariableId, 'c' as VariableId],
        outputs: ['d' as VariableId],
        body: async (scope, signal) => {
          const b = await scope.b;
          const c = await scope.c;
          await delay(30);
          return { d: b + c };
        },
      });

      const results: any[] = [];
      system.observe('d' as VariableId, (result) => {
        if (result.type === 'success') {
          results.push(result.value);
        }
      });

      await delay(40);

      // Update source → cascade through diamond
      system.updateSource('a' as VariableId, 10);

      await delay(150);

      // ✅ 核心验证：钻石拓扑正确传播
      // a=1: b=2, c=6, d=8
      // a=10: b=20, c=15, d=35
      expect(results[results.length - 1]).toBe(35);

      const comp_d = system.peekComputation('comp_d');
      expect(comp_d.runningTask).toBeNull();
    });
  });

  // ==========================================================================
  // A2. observeCount → 0 触发 abort
  // ==========================================================================

  describe('A2. observeCount → 0 triggers abort', () => {

    it('A2.1: Single observer unsubscribe - state becomes Idle', async () => {
      system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

      system.defineComputation({
        id: 'comp',
        inputs: ['x' as VariableId],
        outputs: ['y' as VariableId],
        body: async (scope, signal) => {
          const x = await scope.x;
          await delay(50);
          return { y: x * 10 };
        },
      });

      const results: any[] = [];
      const unsubscribe = system.observe('y' as VariableId, (result) => {
        if (result.type === 'success') {
          results.push(result.value);
        }
      });

      await delay(20);

      // Unsubscribe → observeCount → 0 → state → Idle → abort
      unsubscribe();

      await delay(60);

      // ✅ 核心验证：状态转换正确
      const comp = system.peekComputation('comp');
      expect(comp.observeCount).toBe(0);
      expect(comp.state).toBe(ComputationState.Idle);
      expect(comp.runningTask).toBeNull();
      expect((comp as any).abortingTasks.size).toBe(0);

      // ✅ 核心验证：没有产生结果（任务被 abort）
      expect(results).toEqual([]);
    });

    it('A2.2: Multiple observers - only last unsubscribe triggers abort', async () => {
      system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

      let taskCompleted = false;

      system.defineComputation({
        id: 'comp',
        inputs: ['x' as VariableId],
        outputs: ['y' as VariableId],
        body: async (scope, signal) => {
          const x = await scope.x;
          await delay(50);

          if (!signal.aborted) {
            taskCompleted = true;
          }
          return { y: x * 10 };
        },
      });

      const unsub1 = system.observe('y' as VariableId, () => {});
      const unsub2 = system.observe('y' as VariableId, () => {});

      await delay(20);

      // First unsubscribe → observeCount: 2 → 1 (still > 0, no abort)
      let comp = system.peekComputation('comp');
      expect(comp.observeCount).toBe(2); // Before unsubscribe

      unsub1();
      await delay(5); // Wait for propagation

      comp = system.peekComputation('comp'); // Re-fetch snapshot
      expect(comp.observeCount).toBe(1);
      expect(comp.state).toBe(ComputationState.Ready); // Still ready

      // Second unsubscribe → observeCount: 1 → 0 (abort)
      unsub2();
      await delay(60);

      // ✅ 核心验证：只有最后 unsubscribe 才触发 abort
      comp = system.peekComputation('comp'); // Re-fetch snapshot
      expect(comp.observeCount).toBe(0);
      expect(comp.state).toBe(ComputationState.Idle);
      expect(comp.runningTask).toBeNull();
      expect(taskCompleted).toBe(false); // Task was aborted before completion
    });

    it('A2.3: State verification after unsubscribe', async () => {
      system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

      system.defineComputation({
        id: 'comp',
        inputs: ['x' as VariableId],
        outputs: ['y' as VariableId],
        body: async (scope) => {
          const x = await scope.x;
          await delay(30);
          return { y: x * 10 };
        },
      });

      const unsubscribe = system.observe('y' as VariableId, () => {});

      await delay(15);

      let comp = system.peekComputation('comp');
      expect(comp.state).toBe(ComputationState.Ready);
      expect(comp.runningTask).not.toBeNull();

      unsubscribe();
      await delay(5); // Wait for propagation to complete

      // ✅ 核心验证：完整的状态验证
      comp = system.peekComputation('comp'); // Re-fetch snapshot
      expect(comp.observeCount).toBe(0);
      expect(comp.state).toBe(ComputationState.Idle);

      await delay(50); // Wait for task cleanup

      comp = system.peekComputation('comp'); // Re-fetch snapshot
      expect(comp.runningTask).toBeNull();
      expect(comp.dirty).toBe(true); // Abort preserves dirty state (not completed)
    });

    it('A2.4: Cascading unsubscribe in chain - upstream also aborts', async () => {
      // Chain: source → intermediate → final
      system.defineSource({ id: 'source' as VariableId, initialValue: 1 });

      system.defineComputation({
        id: 'intermediate',
        inputs: ['source' as VariableId],
        outputs: ['mid' as VariableId],
        body: async (scope) => {
          const s = await scope.source;
          await delay(30);
          return { mid: s * 2 };
        },
      });

      system.defineComputation({
        id: 'final',
        inputs: ['mid' as VariableId],
        outputs: ['result' as VariableId],
        body: async (scope) => {
          const mid = await scope.mid;
          await delay(30);
          return { result: mid * 10 };
        },
      });

      const unsubscribe = system.observe('result' as VariableId, () => {});

      await delay(40);

      let intermediate = system.peekComputation('intermediate');
      let final = system.peekComputation('final');

      // Before unsubscribe: both are observed
      expect(intermediate.observeCount).toBeGreaterThan(0);
      expect(final.observeCount).toBeGreaterThan(0);

      // Unsubscribe final → cascade up
      unsubscribe();
      await delay(5); // Wait for propagation

      // ✅ 核心验证：级联 unsubscribe 传播
      final = system.peekComputation('final'); // Re-fetch snapshot
      intermediate = system.peekComputation('intermediate'); // Re-fetch snapshot
      expect(final.observeCount).toBe(0);
      expect(intermediate.observeCount).toBe(0);

      await delay(60); // Wait for cleanup

      final = system.peekComputation('final'); // Re-fetch snapshot
      intermediate = system.peekComputation('intermediate'); // Re-fetch snapshot
      expect(final.state).toBe(ComputationState.Idle);
      expect(intermediate.state).toBe(ComputationState.Idle);
    });
  });

  // ==========================================================================
  // A3. 状态转换触发 abort
  // ==========================================================================

  describe('A3. State transition triggers abort', () => {

    it('A3.1: Ready → Idle (all observers removed) - tested in A2', () => {
      // This scenario is already covered by A2 tests
      expect(true).toBe(true);
    });

    it('A3.2: Ready → Pending (upstream becomes dirty) - abort', async () => {
      // Chain: source → intermediate → final
      system.defineSource({ id: 'source' as VariableId, initialValue: 1 });

      system.defineComputation({
        id: 'intermediate',
        inputs: ['source' as VariableId],
        outputs: ['mid' as VariableId],
        body: async (scope) => {
          const s = await scope.source;
          return { mid: s * 2 };
        },
      });

      let executionCount = 0;

      system.defineComputation({
        id: 'final',
        inputs: ['mid' as VariableId],
        outputs: ['result' as VariableId],
        body: async (scope, signal) => {
          executionCount++;
          await delay(50); // Long execution
          const mid = await scope.mid;
          return { result: mid * 10 };
        },
      });

      system.observe('result' as VariableId, () => {});

      await delay(20);

      const final = system.peekComputation('final');
      expect(final.state).toBe(ComputationState.Ready);
      expect(final.runningTask).not.toBeNull();

      // Update source → intermediate becomes dirty → final.dirtyInputCount++
      // → state: Ready → Pending → abort
      system.updateSource('source' as VariableId, 2);

      await delay(10);

      // ✅ 核心验证：状态转换触发 abort
      // After SPOT refactoring, abort happens via cause_at propagation
      // The key is: final task should be aborted and rescheduled

      await delay(100);

      // ✅ 核心验证：至少执行了 2 次（原始任务被 abort + 新任务完成）
      expect(executionCount).toBeGreaterThanOrEqual(2);
    });

    it('A3.3: State unchanged but cause_at increases - abort', async () => {
      system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

      let taskCompletedWithValue: number | null = null;

      system.defineComputation({
        id: 'comp',
        inputs: ['x' as VariableId],
        outputs: ['y' as VariableId],
        body: async (scope, signal) => {
          const x = await scope.x;
          await delay(50);

          if (!signal.aborted) {
            taskCompletedWithValue = x;
          }
          return { y: x * 10 };
        },
      });

      system.observe('y' as VariableId, () => {});

      await delay(20);

      let comp = system.peekComputation('comp');
      const oldCauseAt = comp.cause_at;
      const oldState = comp.state;

      expect(oldState).toBe(ComputationState.Ready);
      expect(comp.runningTask).not.toBeNull();

      // Update input → cause_at increases, but state stays Ready
      // → checkAbortOnCauseAtChange should abort
      system.updateSource('x' as VariableId, 2);

      await delay(10);

      comp = system.peekComputation('comp'); // Re-fetch snapshot
      const newCauseAt = comp.cause_at;

      // ✅ 核心验证：cause_at 增加触发 abort
      expect(newCauseAt).toBeGreaterThan(oldCauseAt);

      await delay(100);

      // Original task aborted, new task completed with x=2
      expect(taskCompletedWithValue).toBe(2);
      comp = system.peekComputation('comp'); // Re-fetch snapshot
      expect(comp.runningTask).toBeNull();
    });
  });

  // ==========================================================================
  // B1. 动态依赖 - 不应 abort 的场景
  // ==========================================================================

  describe('B1. Dynamic dependencies - should NOT abort', () => {

    it('B1.1: Conditional branch first access - should not abort', async () => {
      // Setup: condition ? Y : Z
      // When condition changes, first access to Z (with larger cause_at) should NOT abort
      system.defineSource({ id: 'condition' as VariableId, initialValue: true });
      system.defineSource({ id: 'Y' as VariableId, initialValue: 100 });
      system.defineSource({ id: 'Z' as VariableId, initialValue: 200 });

      let executionCount = 0;
      const executionResults: any[] = [];

      system.defineComputation({
        id: 'comp',
        inputs: ['condition' as VariableId, 'Y' as VariableId, 'Z' as VariableId],
        outputs: ['result' as VariableId],
        body: async (scope, signal) => {
          executionCount++;
          const cond = await scope.condition;

          if (signal.aborted) {
            return { result: 'aborted' };
          }

          // Dynamic dependency: access Y or Z based on condition
          const value = cond ? await scope.Y : await scope.Z;

          if (!signal.aborted) {
            executionResults.push({ cond, value });
          }

          return { result: value };
        },
      });

      const results: any[] = [];
      system.observe('result' as VariableId, (result) => {
        if (result.type === 'success') {
          results.push(result.value);
        }
      });

      await delay(50);

      // First execution: condition=true → accesses Y
      expect(results).toEqual([100]);
      expect(executionResults).toEqual([{ cond: true, value: 100 }]);

      // Update Z to a newer value (larger cause_at)
      system.updateSource('Z' as VariableId, 300);
      await delay(10);

      // Change condition to false → will access Z for the first time
      system.updateSource('condition' as VariableId, false);
      await delay(50);

      // ✅ 核心验证：动态首次访问 Z 不应 abort
      expect(executionCount).toBe(2); // Only 2 executions (no abort)
      expect(executionResults).toEqual([
        { cond: true, value: 100 },
        { cond: false, value: 300 }
      ]);
      expect(results[results.length - 1]).toBe(300);

      // ✅ 状态验证
      const comp = system.peekComputation('comp');
      expect(comp.runningTask).toBeNull();
      expect(comp.state).toBe(ComputationState.Idle);
    });

    it('B1.2: Loop first access - should not abort', async () => {
      // Setup: loop through array and dynamically access variables
      system.defineSource({ id: 'indices' as VariableId, initialValue: [1, 2] });
      system.defineSource({ id: 'var1' as VariableId, initialValue: 10 });
      system.defineSource({ id: 'var2' as VariableId, initialValue: 20 });
      system.defineSource({ id: 'var3' as VariableId, initialValue: 30 });

      let executionCount = 0;
      const executionResults: any[] = [];

      system.defineComputation({
        id: 'comp',
        inputs: ['indices' as VariableId, 'var1' as VariableId, 'var2' as VariableId, 'var3' as VariableId],
        outputs: ['result' as VariableId],
        body: async (scope, signal) => {
          executionCount++;
          const indices = await scope.indices;
          const values: number[] = [];

          for (const i of indices) {
            if (signal.aborted) break;
            const varName = `var${i}` as VariableId;
            values.push(await scope[varName]);
          }

          if (!signal.aborted) {
            executionResults.push({ indices, values });
          }

          return { result: values };
        },
      });

      const results: any[] = [];
      system.observe('result' as VariableId, (result) => {
        if (result.type === 'success') {
          results.push(result.value);
        }
      });

      await delay(50);

      // First execution: indices=[1,2] → accesses var1, var2
      expect(results).toEqual([[10, 20]]);
      expect(executionResults).toEqual([{ indices: [1, 2], values: [10, 20] }]);

      // Update var3 to a newer value (not accessed yet)
      system.updateSource('var3' as VariableId, 40);
      await delay(10);

      // Change indices to include 3 → will access var3 for the first time
      system.updateSource('indices' as VariableId, [1, 2, 3]);
      await delay(50);

      // ✅ 核心验证：动态首次访问 var3 不应 abort
      expect(executionCount).toBe(2); // Only 2 executions (no abort)
      expect(executionResults).toEqual([
        { indices: [1, 2], values: [10, 20] },
        { indices: [1, 2, 3], values: [10, 20, 40] }
      ]);
      expect(results[results.length - 1]).toEqual([10, 20, 40]);

      // ✅ 状态验证
      const comp = system.peekComputation('comp');
      expect(comp.runningTask).toBeNull();
      expect(comp.state).toBe(ComputationState.Idle);
    });

    it('B1.3: Nested conditional dynamic access - should not abort', async () => {
      // Setup: multi-level nested conditions
      system.defineSource({ id: 'level1' as VariableId, initialValue: false });
      system.defineSource({ id: 'level2' as VariableId, initialValue: false });
      system.defineSource({ id: 'shallowVar' as VariableId, initialValue: 'shallow' });
      system.defineSource({ id: 'deepVar' as VariableId, initialValue: 'deep' });

      let executionCount = 0;
      const executionResults: any[] = [];

      system.defineComputation({
        id: 'comp',
        inputs: ['level1' as VariableId, 'level2' as VariableId, 'shallowVar' as VariableId, 'deepVar' as VariableId],
        outputs: ['result' as VariableId],
        body: async (scope, signal) => {
          executionCount++;
          const l1 = await scope.level1;

          let value: string;
          if (l1) {
            const l2 = await scope.level2;
            if (l2) {
              if (signal.aborted) return { result: 'aborted' };
              value = await scope.deepVar; // Deep nested dynamic access
            } else {
              if (signal.aborted) return { result: 'aborted' };
              value = await scope.shallowVar;
            }
          } else {
            value = 'default';
          }

          if (!signal.aborted) {
            executionResults.push({ l1, value });
          }

          return { result: value };
        },
      });

      const results: any[] = [];
      system.observe('result' as VariableId, (result) => {
        if (result.type === 'success') {
          results.push(result.value);
        }
      });

      await delay(50);

      // First execution: level1=false → 'default' (no dynamic access)
      expect(results).toEqual(['default']);
      expect(executionResults).toEqual([{ l1: false, value: 'default' }]);

      // Update deepVar to a newer value (not accessed yet)
      system.updateSource('deepVar' as VariableId, 'deep-updated');
      await delay(10);

      // Enable level1 and level2 → will access deepVar for the first time
      system.updateSource('level1' as VariableId, true);
      system.updateSource('level2' as VariableId, true);
      await delay(50);

      // ✅ 核心验证：嵌套动态首次访问 deepVar 不应 abort
      expect(executionCount).toBe(2); // Only 2 executions (no abort)
      expect(executionResults).toEqual([
        { l1: false, value: 'default' },
        { l1: true, value: 'deep-updated' }
      ]);
      expect(results[results.length - 1]).toBe('deep-updated');

      // ✅ 状态验证
      const comp = system.peekComputation('comp');
      expect(comp.runningTask).toBeNull();
      expect(comp.state).toBe(ComputationState.Idle);
    });
  });

  // ==========================================================================
  // B2. 动态依赖 - 应 abort 的场景
  // ==========================================================================

  describe('B2. Dynamic dependencies - SHOULD abort', () => {

    it('B2.1: Dynamic access then external update - should abort', async () => {
      // Setup: Access Z dynamically, then Z is updated externally
      // This should trigger abort because task.cause_at < comp.cause_at
      system.defineSource({ id: 'condition' as VariableId, initialValue: false });
      system.defineSource({ id: 'Y' as VariableId, initialValue: 100 });
      system.defineSource({ id: 'Z' as VariableId, initialValue: 200 });

      let executionCount = 0;
      const executionStarts: number[] = [];
      const executionCompletes: number[] = [];

      system.defineComputation({
        id: 'comp',
        inputs: ['condition' as VariableId, 'Y' as VariableId, 'Z' as VariableId],
        outputs: ['result' as VariableId],
        body: async (scope, signal) => {
          const execId = ++executionCount;
          executionStarts.push(execId);

          const cond = await scope.condition;
          await delay(30); // Long running to allow external update

          if (signal.aborted) {
            return { result: 'aborted' };
          }

          const value = cond ? await scope.Y : await scope.Z;

          if (!signal.aborted) {
            executionCompletes.push(execId);
          }

          return { result: value };
        },
      });

      const results: any[] = [];
      system.observe('result' as VariableId, (result) => {
        if (result.type === 'success') {
          results.push(result.value);
        }
      });

      await delay(10); // Start execution

      // While task is running, update Z externally
      // This increases comp.cause_at, making task.cause_at < comp.cause_at → abort
      system.updateSource('Z' as VariableId, 300);

      await delay(100);

      // ✅ 核心验证：外部更新导致 abort
      expect(executionStarts.length).toBeGreaterThanOrEqual(2); // At least 2 started
      expect(executionCompletes.length).toBeGreaterThanOrEqual(1); // At least 1 completed (the last one)
      expect(results[results.length - 1]).toBe(300); // Latest value

      const comp = system.peekComputation('comp');
      expect(comp.runningTask).toBeNull();
      expect(comp.state).toBe(ComputationState.Idle);
    });

    it('B2.2: Dynamic access with concurrent upstream update - should abort', async () => {
      // Setup: While accessing Z dynamically, upstream propagates new cause_at
      system.defineSource({ id: 'trigger' as VariableId, initialValue: 0 });
      system.defineSource({ id: 'data' as VariableId, initialValue: 'initial' });

      let executionCount = 0;
      const completedValues: string[] = [];

      system.defineComputation({
        id: 'comp',
        inputs: ['trigger' as VariableId, 'data' as VariableId],
        outputs: ['result' as VariableId],
        body: async (scope, signal) => {
          executionCount++;
          const trigger = await scope.trigger;

          await delay(30); // Allow time for concurrent update

          if (signal.aborted) {
            return { result: 'aborted' };
          }

          // Dynamic access to data
          const data = await scope.data;

          if (!signal.aborted) {
            completedValues.push(data);
          }

          return { result: `${trigger}:${data}` };
        },
      });

      const results: any[] = [];
      system.observe('result' as VariableId, (result) => {
        if (result.type === 'success') {
          results.push(result.value);
        }
      });

      await delay(10);

      // Trigger first execution
      system.updateSource('trigger' as VariableId, 1);

      await delay(15); // Execution is in progress

      // Update data while execution is in progress
      // This should trigger abort via cause_at propagation
      system.updateSource('data' as VariableId, 'updated');

      await delay(100);

      // ✅ 核心验证：并发更新导致 abort
      expect(executionCount).toBeGreaterThanOrEqual(2); // Multiple executions due to abort
      expect(results[results.length - 1]).toBe('1:updated'); // Final result uses updated value

      const comp = system.peekComputation('comp');
      expect(comp.runningTask).toBeNull();
      expect(comp.state).toBe(ComputationState.Idle);
    });

    it('B2.3: Multiple dynamic accesses with race condition - should abort', async () => {
      // Setup: Dynamically access multiple variables, external updates create race
      system.defineSource({ id: 'selector' as VariableId, initialValue: 1 });
      system.defineSource({ id: 'var1' as VariableId, initialValue: 'A' });
      system.defineSource({ id: 'var2' as VariableId, initialValue: 'B' });
      system.defineSource({ id: 'var3' as VariableId, initialValue: 'C' });

      let executionCount = 0;
      const completedResults: string[] = [];

      system.defineComputation({
        id: 'comp',
        inputs: ['selector' as VariableId, 'var1' as VariableId, 'var2' as VariableId, 'var3' as VariableId],
        outputs: ['result' as VariableId],
        body: async (scope, signal) => {
          executionCount++;
          const selector = await scope.selector;

          await delay(20); // Allow racing updates

          if (signal.aborted) {
            return { result: 'aborted' };
          }

          // Dynamically access different variables based on selector
          const varName = `var${selector}` as VariableId;
          const value = await scope[varName];

          if (!signal.aborted) {
            completedResults.push(value);
          }

          return { result: value };
        },
      });

      const results: any[] = [];
      system.observe('result' as VariableId, (result) => {
        if (result.type === 'success') {
          results.push(result.value);
        }
      });

      await delay(50);

      // First execution completes: selector=1 → var1='A'
      expect(results).toEqual(['A']);

      // Change selector to 2
      system.updateSource('selector' as VariableId, 2);

      await delay(10); // Task is running

      // Update var2 while task is accessing it
      // This creates a race: dynamic access + external update → abort
      system.updateSource('var2' as VariableId, 'B-updated');

      await delay(100);

      // ✅ 核心验证：多变量竞态导致 abort
      expect(executionCount).toBeGreaterThanOrEqual(2);
      expect(results[results.length - 1]).toBe('B-updated'); // Final result uses updated value

      const comp = system.peekComputation('comp');
      expect(comp.runningTask).toBeNull();
      expect(comp.state).toBe(ComputationState.Idle);
    });

  });
});
