import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ComputationState, VariableId } from '../../src/reactive/types';
import { ReactiveModule } from "../../src/reactive/reactive_module";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('Core Invariants - P0-Test-8/9/10', () => {
  let system: ReactiveModule;
  const computationIds: string[] = [];

  beforeEach(() => {
    system = new ReactiveModule({ logLevel: 'error', assertInvariants: true });
    computationIds.length = 0;
  });

  // ========== 通用不变量检查（所有测试后执行） ==========

  afterEach(() => {
    // 检查所有 computations 的不变量
    computationIds.forEach(id => {
      const comp = system.peekComputation(id);

      // INV-2: runningTask !== null ⇒ state === Ready
      if (comp.runningTask !== null) {
        expect(comp.state).toBe(ComputationState.Ready);
      }

      // INV-3: runningTask 与 abortingTasks 互斥
      if (comp.runningTask !== null) {
        expect(comp.abortingTasks.has(comp.runningTask)).toBe(false);
      }

      // INV-4: abortingTasks 中的所有 task 都已 aborted
      comp.abortingTasks.forEach(task => {
        expect(task.abortController.signal.aborted).toBe(true);
      });
    });
  });

  // ========== 具体场景测试 ==========

  describe('INV-2: runningTask !== null ⇒ state === Ready', () => {
    it('执行中的 computation 必须处于 Ready 状态', async () => {
      // 1. Setup
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
      computationIds.push('comp');

      // 2. 开始执行
      system.observe('y' as VariableId, () => {});
      await delay(15);

      // 3. 验证：runningTask !== null ⇒ state === Ready
      const comp = system.peekComputation('comp');
      if (comp.runningTask !== null) {
        expect(comp.state).toBe(ComputationState.Ready);
      }

      // 4. 等待完成
      await delay(40);
    });

    it('Unsubscribe 后，runningTask 应立即清空', async () => {
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
      computationIds.push('comp');

      // 2. 开始执行
      const observer = system.observe('y' as VariableId, () => {});
      await delay(15);

      // 3. Unsubscribe
      observer();

      // 4. 验证：state = Idle, runningTask = null（不违反 INV-2）
      const comp = system.peekComputation('comp');
      expect(comp.state).toBe(ComputationState.Idle);
      expect(comp.runningTask).toBeNull();

      // 如果有 runningTask，必须是 Ready
      if (comp.runningTask !== null) {
        expect(comp.state).toBe(ComputationState.Ready);
      }
    });

    it('输入变化导致 Pending 时，runningTask 应清空', async () => {
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
      computationIds.push('comp_b');

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
      computationIds.push('comp');

      // 2. 开始观察并等待首次完成
      system.observe('y' as VariableId, () => {});
      await delay(70);

      // 3. 更新 a，触发新执行
      system.updateSource('a' as VariableId, 10);
      await delay(15);

      // 4. 更新 s_b 使 b 变为 dirty → state = Pending
      system.updateSource('s_b' as VariableId, 10);

      // 5. 验证：如果 state = Pending，runningTask 必须为 null
      const comp = system.peekComputation('comp');
      if (comp.state === ComputationState.Pending) {
        expect(comp.runningTask).toBeNull();
      }
    });
  });

  describe('INV-3: runningTask 与 abortingTasks 互斥', () => {
    it('runningTask 不能同时在 abortingTasks 中', async () => {
      // 1. Setup
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
      computationIds.push('comp');

      // 2. 开始执行
      system.observe('y' as VariableId, () => {});
      await delay(15);

      // 3. 验证：runningTask ∉ abortingTasks
      const comp = system.peekComputation('comp');
      if (comp.runningTask !== null) {
        expect(comp.abortingTasks.has(comp.runningTask)).toBe(false);
      }

      // 4. 更新输入，触发 abort + 重新调度
      system.updateSource('x' as VariableId, 2);
      await delay(15);

      // 5. 验证：新的 runningTask ∉ abortingTasks
      const compAfter = system.peekComputation('comp');
      if (compAfter.runningTask !== null) {
        expect(compAfter.abortingTasks.has(compAfter.runningTask)).toBe(false);
      }

      // 6. 等待完成
      await delay(100);
    });

    it('Abort 后的 task 移至 abortingTasks', async () => {
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
      computationIds.push('comp');

      // 2. 开始执行
      const observer = system.observe('y' as VariableId, () => {});
      await delay(15);

      // 3. 记录旧 task
      const comp = system.peekComputation('comp');
      const oldTask = comp.runningTask;
      expect(oldTask).not.toBeNull();

      // 4. Unsubscribe → abort
      observer();

      // 5. 验证：旧 task 在 abortingTasks 中
      const compAfter = system.peekComputation('comp');
      expect(compAfter.runningTask).toBeNull();
      expect(compAfter.abortingTasks.size).toBe(1);
      expect(compAfter.abortingTasks.has(oldTask!)).toBe(true);

      // 6. 验证：互斥性仍然满足（runningTask = null）
      if (compAfter.runningTask !== null) {
        expect(compAfter.abortingTasks.has(compAfter.runningTask)).toBe(false);
      }
    });
  });

  describe('INV-4: abortingTasks 中的所有 task 都已 aborted', () => {
    it('Abort 的 task 的 signal.aborted 为 true', async () => {
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
      computationIds.push('comp');

      // 2. 开始执行
      const observer = system.observe('y' as VariableId, () => {});
      await delay(15);

      // 3. Unsubscribe → abort
      observer();

      // 4. 验证：abortingTasks 中的 task 都已 aborted
      const comp = system.peekComputation('comp');
      comp.abortingTasks.forEach(task => {
        expect(task.abortController.signal.aborted).toBe(true);
      });

      // 5. 等待清理
      await delay(60);

      // 6. 验证：清理后 abortingTasks 为空
      const compFinal = system.peekComputation('comp');
      expect(compFinal.abortingTasks.size).toBe(0);
    });

    it('快速连续 abort，所有 task 都标记为 aborted', async () => {
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
      computationIds.push('comp');

      // 2. 开始执行
      system.observe('y' as VariableId, () => {});
      await delay(15);

      // 3. 快速连续更新（触发多次 abort）
      system.updateSource('x' as VariableId, 2);
      await delay(10);
      system.updateSource('x' as VariableId, 3);
      await delay(10);
      system.updateSource('x' as VariableId, 4);

      // 4. 验证：所有 abortingTasks 都已 aborted
      const comp = system.peekComputation('comp');
      comp.abortingTasks.forEach(task => {
        expect(task.abortController.signal.aborted).toBe(true);
      });

      // 5. 等待所有完成
      await delay(200);

      // 6. 最终验证：所有清理完成
      const compFinal = system.peekComputation('comp');
      expect(compFinal.abortingTasks.size).toBe(0);
    });
  });

  describe('综合场景：多个不变量同时验证', () => {
    it('复杂交互场景中，所有不变量始终成立', async () => {
      // 1. Setup
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
      computationIds.push('comp');

      // 2. 开始观察
      const observer1 = system.observe('y' as VariableId, () => {});
      await delay(15);

      // 验证点 1：执行中
      let comp = system.peekComputation('comp');
      if (comp.runningTask !== null) {
        expect(comp.state).toBe(ComputationState.Ready); // INV-2
        expect(comp.abortingTasks.has(comp.runningTask)).toBe(false); // INV-3
      }

      // 3. 添加第二个 observer
      const observer2 = system.observe('y' as VariableId, () => {});

      // 验证点 2：observeCount = 2
      comp = system.peekComputation('comp');
      if (comp.runningTask !== null) {
        expect(comp.state).toBe(ComputationState.Ready);
        expect(comp.abortingTasks.has(comp.runningTask)).toBe(false);
      }

      // 4. 移除第一个 observer
      observer1();

      // 验证点 3：observeCount = 1，仍在执行
      comp = system.peekComputation('comp');
      if (comp.runningTask !== null) {
        expect(comp.state).toBe(ComputationState.Ready);
      }

      // 5. 等待完成
      await delay(40);

      // 6. 更新输入，触发新执行
      system.updateSource('x' as VariableId, 2);
      await delay(15);

      // 验证点 4：新任务执行中
      comp = system.peekComputation('comp');
      if (comp.runningTask !== null) {
        expect(comp.state).toBe(ComputationState.Ready); // INV-2
        expect(comp.abortingTasks.has(comp.runningTask)).toBe(false); // INV-3
      }

      // 验证 INV-4
      comp.abortingTasks.forEach(task => {
        expect(task.abortController.signal.aborted).toBe(true);
      });

      // 7. 移除最后一个 observer
      observer2();

      // 验证点 5：Idle 状态
      comp = system.peekComputation('comp');
      expect(comp.state).toBe(ComputationState.Idle);
      expect(comp.runningTask).toBeNull(); // INV-2 满足

      // 8. 等待所有清理完成
      await delay(100);

      // 最终验证：所有不变量成立
      comp = system.peekComputation('comp');
      expect(comp.abortingTasks.size).toBe(0);
      if (comp.runningTask !== null) {
        expect(comp.state).toBe(ComputationState.Ready);
        expect(comp.abortingTasks.has(comp.runningTask)).toBe(false);
      }
      comp.abortingTasks.forEach(task => {
        expect(task.abortController.signal.aborted).toBe(true);
      });
    });
  });
});
