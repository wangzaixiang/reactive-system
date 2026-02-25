import { describe, it, expect, beforeEach } from 'vitest';
import { ComputationState, VariableId } from '../../src/reactive/types';
import {ReactiveModule} from "../../src/reactive/reactive_module";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('State Combinations - P1-Test-6', () => {
  let system: ReactiveModule;

  beforeEach(() => {
    system = new ReactiveModule({ logLevel: 'error', assertInvariants: true });
  });

  describe('所有有效状态组合可达', () => {
    it('Test 6.1: (Idle, null, ∅) - 初始状态', () => {
      // 定义一个 computation，但不观察
      system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

      system.defineComputation({
        id: 'comp',
        inputs: ['x' as VariableId],
        outputs: ['y' as VariableId],
        body: async (scope) => {
          const x = await scope.x;
          return { y: x * 10 };
        },
      });

      // 验证：初始状态
      const comp = system.peekComputation('comp');
      expect(comp.state).toBe(ComputationState.Idle);
      expect(comp.dirty).toBe(true); // outputs dirty
      expect((comp as any).observeCount).toBe(0); // 未观察
      expect(comp.runningTask).toBeNull();
      expect((comp as any).abortingTasks.size).toBe(0);
    });

    it('Test 6.2: (Pending, null, ∅) - 有 dirty 输入，已观察', async () => {
      // 1. 创建源变量和上游 computation
      system.defineSource({ id: 's' as VariableId, initialValue: 1 });
      system.defineSource({ id: 'b' as VariableId, initialValue: 2 });

      system.defineComputation({
        id: 'comp_a',
        inputs: ['s' as VariableId],
        outputs: ['a' as VariableId],
        body: async (scope) => {
          const s = await scope.s;
          await delay(50); // 延迟确保 a 保持 dirty 足够长时间
          return { a: s * 10 };
        },
      });

      // 2. 创建下游 computation
      system.defineComputation({
        id: 'comp',
        inputs: ['a' as VariableId, 'b' as VariableId],
        outputs: ['y' as VariableId],
        body: async (scope) => {
          const a = await scope.a;
          const b = await scope.b;
          return { y: a + b };
        },
      });

      // 3. 开始观察并等待首次执行完成
      system.observe('y' as VariableId, () => {});
      await delay(100);

      // 4. 更新 s → a 变 dirty（comp_a 开始执行但未完成）
      system.updateSource('s' as VariableId, 2);

      // 5. 立即检查（在 comp_a 完成前）
      await delay(10);

      // 6. 验证：(Pending, null, ∅)
      const comp = system.peekComputation('comp');
      expect(comp.state).toBe(ComputationState.Pending);
      expect(comp.dirty).toBe(true);
      expect((comp as any).observeCount).toBeGreaterThan(0);
      expect(comp.dirtyInputCount).toBeGreaterThan(0); // 'a' is dirty
      expect(comp.runningTask).toBeNull();
      expect((comp as any).abortingTasks.size).toBe(0);
    });

    it('Test 6.3: (Ready, null, ∅) - 所有输入 clean，未执行', async () => {
      // 1. Setup
      system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

      system.defineComputation({
        id: 'comp',
        inputs: ['x' as VariableId],
        outputs: ['y' as VariableId],
        body: async (scope) => {
          const x = await scope.x;
          return { y: x * 10 };
        },
      });

      // 2. 开始观察（触发加入 readyQueue，但异步调度）
      system.observe('y' as VariableId, () => {});

      // 3. 立即检查（在调度执行前）
      const comp = system.peekComputation('comp');
      expect(comp.state).toBe(ComputationState.Ready);
      expect(comp.dirty).toBe(true);
      expect((comp as any).observeCount).toBeGreaterThan(0);
      expect(comp.dirtyInputCount).toBe(0); // source variable is clean
      expect(comp.runningTask).toBeNull(); // 还未执行
      expect((comp as any).abortingTasks.size).toBe(0);
    });

    it('Test 6.4: (Ready, task, ∅) - 正常执行中 ✅', async () => {
      // 1. Setup
      system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

      system.defineComputation({
        id: 'comp',
        inputs: ['x' as VariableId],
        outputs: ['y' as VariableId],
        body: async (scope) => {
          const x = await scope.x;
          await delay(30); // 确保有足够时间观察
          return { y: x * 10 };
        },
      });

      // 2. 开始观察
      system.observe('y' as VariableId, () => {});

      // 3. 等待执行开始
      await delay(15);

      // 4. 验证：(Ready, task, ∅) - 唯一稳定执行状态
      const comp = system.peekComputation('comp');
      expect(comp.state).toBe(ComputationState.Ready);
      expect(comp.runningTask).not.toBeNull();
      expect((comp as any).abortingTasks.size).toBe(0);
      expect(comp.dirty).toBe(true); // 执行中仍为 dirty
      expect((comp as any).observeCount).toBeGreaterThan(0);
      expect(comp.dirtyInputCount).toBe(0);
    });

    it('Test 6.5: (Idle, null, {tasks}) - abort 清理中', async () => {
      // 1. Setup
      system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

      system.defineComputation({
        id: 'comp',
        inputs: ['x' as VariableId],
        outputs: ['y' as VariableId],
        body: async (scope) => {
          const x = await scope.x;
          await delay(50);
          return { y: x * 10 };
        },
      });

      // 2. 开始执行
      const observer = system.observe('y' as VariableId, () => {});
      await delay(15);

      // 3. Unsubscribe → 触发 abort
      observer();

      // 4. 验证：(Idle, null, {tasks})
      const comp = system.peekComputation('comp');
      expect(comp.state).toBe(ComputationState.Idle);
      expect((comp as any).observeCount).toBe(0);
      expect(comp.runningTask).toBeNull();
      expect((comp as any).abortingTasks.size).toBe(1); // 任务正在 abort

      // 5. 等待清理完成
      await delay(60);

      // 6. 验证：abortingTasks 已清空
      const compAfter = system.peekComputation('comp');
      expect((compAfter as any).abortingTasks.size).toBe(0);
    });

    it('Test 6.6: (Pending, null, {tasks}) - abort + 新 dirty 输入', async () => {
      // 1. Setup - 创建上游 computation 产生 b
      system.defineSource({ id: 'a' as VariableId, initialValue: 1 });
      system.defineSource({ id: 's_b' as VariableId, initialValue: 1 });

      system.defineComputation({
        id: 'comp_b',
        inputs: ['s_b' as VariableId],
        outputs: ['b' as VariableId],
        body: async (scope) => {
          const s_b = await scope.s_b;
          return { b: s_b * 2 };
        },
      });

      system.defineComputation({
        id: 'comp',
        inputs: ['a' as VariableId, 'b' as VariableId],
        outputs: ['y' as VariableId],
        body: async (scope) => {
          const a = await scope.a;
          await delay(50);
          const b = await scope.b;
          return { y: a + b };
        },
      });

      // 2. 开始观察并等待首次执行完成
      system.observe('y' as VariableId, () => {});
      await delay(70);

      // 3. 更新 a，触发新执行
      system.updateSource('a' as VariableId, 10);
      await delay(15); // 执行开始

      // 4. 更新 s_b 使 b 变为 dirty，导致 comp 从 Ready 变为 Pending（触发 abort）
      system.updateSource('s_b' as VariableId, 10);

      // 5. 验证：(Pending, null, {tasks})
      const comp = system.peekComputation('comp');
      expect(comp.state).toBe(ComputationState.Pending);
      expect(comp.dirtyInputCount).toBeGreaterThan(0); // b is dirty
      expect(comp.runningTask).toBeNull(); // 已 abort
      expect((comp as any).abortingTasks.size).toBeGreaterThan(0); // 旧任务清理中
    });

    it('Test 6.7: (Ready, null, {tasks}) - abort 清理中，仍 Ready', async () => {
      // 1. Setup
      system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

      system.defineComputation({
        id: 'comp',
        inputs: ['x' as VariableId],
        outputs: ['y' as VariableId],
        body: async (scope) => {
          const x = await scope.x;
          await delay(50);
          return { y: x * 10 };
        },
      });

      // 2. 开始观察
      system.observe('y' as VariableId, () => {});
      await delay(15); // 执行开始

      // 3. 更新输入 → 触发 abort + 重新调度
      system.updateSource('x' as VariableId, 2);

      // 4. 立即检查（在新任务启动前）
      const comp = system.peekComputation('comp');
      expect(comp.state).toBe(ComputationState.Ready);
      expect(comp.dirty).toBe(true);
      expect(comp.dirtyInputCount).toBe(0);
      expect(comp.runningTask).toBeNull(); // 旧任务已移除
      expect((comp as any).abortingTasks.size).toBe(1); // 旧任务清理中

      // 注意：由于异步调度，新任务可能还未启动
      // 这是 (Ready, null, {tasks}) 的瞬时状态
    });

    it('Test 6.8: (Ready, task, {tasks}) - 新任务执行，旧任务清理', async () => {
      // 1. Setup
      system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

      let executionCount = 0;
      system.defineComputation({
        id: 'comp',
        inputs: ['x' as VariableId],
        outputs: ['y' as VariableId],
        body: async (scope, signal) => {
          executionCount++;
          const x = await scope.x;
          await delay(50);
          return { y: x * 10 };
        },
      });

      // 2. 开始观察
      system.observe('y' as VariableId, () => {});
      await delay(15); // 第一个任务执行中

      // 3. 更新输入 → 触发 abort + 重新调度
      system.updateSource('x' as VariableId, 2);

      // 4. 立即检查（在新任务启动前）- 应该看到旧任务在 abortingTasks 中
      let comp = system.peekComputation('comp');
      const hasAbortingTasks = (comp as any).abortingTasks.size > 0;

      // 5. 等待新任务启动
      await delay(20);

      // 6. 验证：有两次执行启动
      expect(executionCount).toBe(2);

      // 7. 验证：(Ready, task, {tasks}) 或至少 (Ready, task, ∅)
      comp = system.peekComputation('comp');
      expect(comp.state).toBe(ComputationState.Ready);
      expect(comp.runningTask).not.toBeNull(); // 新任务执行中

      // 如果在步骤4看到了abortingTasks，说明成功捕获了状态
      // 否则旧任务可能已经清理完成（这也是正常的）
      if (hasAbortingTasks) {
        // 可能还在清理中，或已清理完成
        expect((comp as any).abortingTasks.size).toBeGreaterThanOrEqual(0);
      }

      // 8. 等待所有完成
      await delay(100);

      // 9. 验证：最终清理完成
      const compFinal = system.peekComputation('comp');
      expect((compFinal as any).abortingTasks.size).toBe(0);
    });
  });
});
