import { describe, it, expect, beforeEach } from 'vitest';
import { ReactiveModule } from '../../src/reactive/reactive_module';
import { VariableId } from '../../src/reactive/types';
import {createReactiveModule} from "./utils";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('Abort Scenarios - Comprehensive', () => {
  let system: ReactiveModule;

  beforeEach(() => {
    system = createReactiveModule({
      assertInvariants: true,
      abortStrategy: 'immediate' // 使用 immediate 模式，更容易观察 abort
    });
  });

  describe('场景 1: cause_at 向下传播导致 abort', () => {
    it('输入变量更新触发 cause_at 传播，abort 正在执行的任务', async () => {
      // 1. Setup
      system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

      let executionCount = 0;
      let abortCount = 0;

      system.defineComputation({
        id: 'comp',
        inputs: ['x' as VariableId],
        outputs: ['y' as VariableId],
        body: async (scope, signal) => {
          executionCount++;
          const execId = executionCount;

          signal.addEventListener('abort', () => {
            abortCount++;
          });

          const x = await scope.x;
          await delay(50); // 长时间执行
          return { y: x * 10 };
        },
      });

      // 2. 开始观察，触发第一次执行
      const results: any[] = [];
      system.observe('y' as VariableId, (result) => {
        if (result.type === 'success') {
          results.push(result.value);
        }
      });

      // 3. 等待任务执行到一半
      await delay(20);

      // 4. 更新输入 → cause_at 传播 → 应该 abort 旧任务
      system.updateSource('x' as VariableId, 2);

      // 5. 等待新任务完成
      await delay(100);

      // 6. 验证
      expect(executionCount).toBe(2); // 两次执行（第一次被 abort，第二次完成）
      expect(results.length).toBe(1); // 只有一个结果（第二次执行）
      expect(results[0]).toBe(20);    // 最新的值
      expect(abortCount).toBe(1);     // 一次 abort
    });

    it('连续多次更新，只有最后一次执行完成', async () => {
      system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

      let executionCount = 0;
      let completedExecutions = 0;

      system.defineComputation({
        id: 'comp',
        inputs: ['x' as VariableId],
        outputs: ['y' as VariableId],
        body: async (scope, signal) => {
          const execId = ++executionCount;
          const x = await scope.x;

          await delay(50);

          // 如果没被 abort，标记为完成
          if (!signal.aborted) {
            completedExecutions++;
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

      // 连续更新 5 次
      for (let i = 2; i <= 6; i++) {
        system.updateSource('x' as VariableId, i);
        await delay(10); // 短暂延迟
      }

      // 等待最后一次执行完成
      await delay(100);

      // 验证：多次执行，但只有最后一次完成
      expect(executionCount).toBeGreaterThan(1); // 至少 2 次执行
      expect(completedExecutions).toBe(1);       // 只有 1 次完成（最后一次）
      expect(results.length).toBe(1);            // 只有 1 个结果
      expect(results[0]).toBe(60);               // 最后的值 (6 * 10)
    });
  });

  describe('场景 2: observe 向上传播导致 abort', () => {
    it('unsubscribe 触发 observeCount → 0，abort 正在执行的任务', async () => {
      system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

      let abortCount = 0;

      system.defineComputation({
        id: 'comp',
        inputs: ['x' as VariableId],
        outputs: ['y' as VariableId],
        body: async (scope, signal) => {
          signal.addEventListener('abort', () => {
            abortCount++;
          });

          const x = await scope.x;
          await delay(50); // 长时间执行
          return { y: x * 10 };
        },
      });

      // 开始观察
      const unsubscribe = system.observe('y' as VariableId, () => {});

      // 等待任务执行到一半
      await delay(20);

      // Unsubscribe → observeCount 变为 0 → 应该 abort
      unsubscribe();

      // 等待 abort 完成
      await delay(60);

      // 验证
      expect(abortCount).toBe(1);

      const comp = system.peekComputation('comp');
      expect(comp.observeCount).toBe(0);
      expect(comp.runningTask).toBeNull();
      expect((comp as any).abortingTasks.size).toBe(0); // 清理完成
    });

    it('多个 observer，只有全部 unsubscribe 才 abort', async () => {
      system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

      let abortCount = 0;

      system.defineComputation({
        id: 'comp',
        inputs: ['x' as VariableId],
        outputs: ['y' as VariableId],
        body: async (scope, signal) => {
          signal.addEventListener('abort', () => {
            abortCount++;
          });

          const x = await scope.x;
          await delay(50);
          return { y: x * 10 };
        },
      });

      // 两个 observers
      const unsub1 = system.observe('y' as VariableId, () => {});
      const unsub2 = system.observe('y' as VariableId, () => {});

      await delay(20);

      // 只 unsubscribe 一个 → 不应 abort（observeCount 仍 > 0）
      unsub1();
      await delay(10);
      expect(abortCount).toBe(0);

      // unsubscribe 第二个 → 应该 abort
      unsub2();
      await delay(60);
      expect(abortCount).toBe(1);
    });
  });

  describe('场景 3: 动态依赖 - 访问新变量不引起 abort', () => {
    it('执行中动态访问 cause_at 更大的变量，不应 abort', async () => {
      // Setup: 创建条件依赖 (X ? Y : Z)
      system.defineSource({ id: 'condition' as VariableId, initialValue: true });
      system.defineSource({ id: 'Y' as VariableId, initialValue: 10 });
      system.defineSource({ id: 'Z' as VariableId, initialValue: 20 });

      let abortCount = 0;
      let executionCount = 0;

      system.defineComputation({
        id: 'comp',
        inputs: ['condition' as VariableId, 'Y' as VariableId, 'Z' as VariableId],
        outputs: ['result' as VariableId],
        body: async (scope, signal) => {
          executionCount++;

          signal.addEventListener('abort', () => {
            abortCount++;
          });

          const cond = await scope.condition;
          await delay(20); // 模拟异步操作

          // 动态依赖：首次访问 Z（cause_at 可能更大）
          const value = cond ? (await scope.Y) : (await scope.Z);

          return { result: value };
        },
      });

      // 先更新 Z，增加其 cause_at
      system.updateSource('Z' as VariableId, 100);
      await delay(10);

      // 开始观察（此时 condition=true，会访问 Y）
      const results: any[] = [];
      system.observe('result' as VariableId, (res) => {
        if (res.type === 'success') {
          results.push(res.value);
        }
      });

      await delay(50);

      // 第一次执行完成，没有 abort
      expect(abortCount).toBe(0);
      expect(executionCount).toBe(1);
      expect(results[0]).toBe(10); // 使用 Y 的值

      // 修改 condition → 触发重新执行 → 访问 Z（cause_at 更大）
      system.updateSource('condition' as VariableId, false);
      await delay(100);

      // 第二次执行时动态访问了 Z（cause_at 更大），但不应 abort
      // 因为这是动态依赖场景，task.cause_at == oldCauseAt
      expect(abortCount).toBe(0); // 没有额外的 abort
      expect(executionCount).toBe(2);
      expect(results[1]).toBe(100); // 使用 Z 的值
    });
  });

  describe('场景 4: 动态依赖 - 访问后再次变化引起 abort', () => {
    it('动态访问新变量后，外部再次更新输入，应 abort', async () => {
      system.defineSource({ id: 'condition' as VariableId, initialValue: false });
      system.defineSource({ id: 'Y' as VariableId, initialValue: 10 });
      system.defineSource({ id: 'Z' as VariableId, initialValue: 20 });

      let abortCount = 0;
      let executionCount = 0;

      system.defineComputation({
        id: 'comp',
        inputs: ['condition' as VariableId, 'Y' as VariableId, 'Z' as VariableId],
        outputs: ['result' as VariableId],
        body: async (scope, signal) => {
          const execId = ++executionCount;

          signal.addEventListener('abort', () => {
            abortCount++;
          });

          const cond = await scope.condition;

          // 第一个延迟：模拟动态依赖访问前的计算
          await delay(30);

          // 动态访问（此时可能触发 cause_at 更新）
          const value = cond ? (await scope.Y) : (await scope.Z);

          // 第二个延迟：动态访问后的计算（在此期间外部可能更新）
          await delay(30);

          return { result: value };
        },
      });

      const results: any[] = [];
      system.observe('result' as VariableId, (res) => {
        if (res.type === 'success') {
          results.push(res.value);
        }
      });

      // 等待第一次执行到中间（动态访问 Z 后）
      await delay(50);

      // 此时任务正在执行，已经动态访问了 Z
      // 现在外部更新 Z → cause_at 再次增加 → 应该 abort
      system.updateSource('Z' as VariableId, 200);

      // 等待新任务完成
      await delay(100);

      // 验证：第一次执行被 abort，第二次执行完成
      expect(abortCount).toBe(1);
      expect(executionCount).toBe(2);
      expect(results.length).toBe(1); // 只有一个结果（第二次执行）
      expect(results[0]).toBe(200);   // 最新的值
    });
  });

  describe('场景 5: dirtyInputCount 增加导致状态变化', () => {
    it('执行中输入变为 dirty，状态从 Ready 变为 Pending，abort', async () => {
      // Setup: 创建链式依赖 source → intermediate → final
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

      let abortCount = 0;

      system.defineComputation({
        id: 'final',
        inputs: ['mid' as VariableId],
        outputs: ['result' as VariableId],
        body: async (scope, signal) => {
          signal.addEventListener('abort', () => {
            abortCount++;
          });

          await delay(50); // 长时间执行
          const mid = await scope.mid;
          return { result: mid * 10 };
        },
      });

      system.observe('result' as VariableId, () => {});

      // 等待 final 执行到一半
      await delay(20);

      // 更新 source → intermediate 变 dirty → final.dirtyInputCount++
      // → 状态从 Ready 变为 Pending → abort
      system.updateSource('source' as VariableId, 2);

      await delay(100);

      // 验证
      expect(abortCount).toBe(1);
    });
  });

  describe('场景 6: abort 的幂等性', () => {
    it('多次触发 abort，只 abort 一次', async () => {
      system.defineSource({ id: 'x' as VariableId, initialValue: 1 });
      system.defineSource({ id: 'y' as VariableId, initialValue: 1 });

      let abortCount = 0;

      system.defineComputation({
        id: 'comp',
        inputs: ['x' as VariableId, 'y' as VariableId],
        outputs: ['result' as VariableId],
        body: async (scope, signal) => {
          signal.addEventListener('abort', () => {
            abortCount++;
          });

          const x = await scope.x;
          await delay(50);
          const y = await scope.y;
          return { result: x + y };
        },
      });

      system.observe('result' as VariableId, () => {});

      await delay(20);

      // 快速连续更新两个输入（在同一个 tick 内）
      system.updateSource('x' as VariableId, 2);
      system.updateSource('y' as VariableId, 2);

      await delay(100);

      // 验证：虽然两个输入都更新了，但只 abort 一次
      expect(abortCount).toBe(1);
    });
  });

  describe('场景 7: abort 后的清理', () => {
    it('abort 后任务进入 abortingTasks，finally 后清空', async () => {
      system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

      const results: any[] = [];
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

      system.observe('y' as VariableId, (result) => {
        if (result.type === 'success') {
          results.push(result.value);
        }
      });

      await delay(20);

      // 触发 abort
      system.updateSource('x' as VariableId, 2);

      // 立即检查：应该在 abortingTasks 中
      const comp = system.peekComputation('comp');
      await delay(5); // 给 abort 一点时间
      expect((comp as any).abortingTasks.size).toBeGreaterThan(0);

      // 等待所有任务完成
      await delay(100);

      // 验证：abortingTasks 已清空，新任务已完成并输出正确结果
      expect((comp as any).abortingTasks.size).toBe(0);
      expect(results.length).toBe(1); // 只有新任务的结果
      expect(results[0]).toBe(20); // x=2 的结果
    });
  });

  describe('场景 8: 边界情况', () => {
    it('任务开始前就被 abort（极端竞态）', async () => {
      system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

      let executionStarted = false;

      system.defineComputation({
        id: 'comp',
        inputs: ['x' as VariableId],
        outputs: ['y' as VariableId],
        body: async (scope) => {
          executionStarted = true;
          const x = await scope.x;
          return { y: x * 10 };
        },
      });

      system.observe('y' as VariableId, () => {});

      // 立即更新（在任务真正开始前）
      system.updateSource('x' as VariableId, 2);

      await delay(50);

      // 验证：可能只执行一次（如果更新足够快）
      // 或执行两次（如果第一次已经开始）
      expect(executionStarted).toBe(true);
    });

    it('abort 后 finally 中发现仍然 dirty，重新调度', async () => {
      system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

      let executionCount = 0;

      system.defineComputation({
        id: 'comp',
        inputs: ['x' as VariableId],
        outputs: ['y' as VariableId],
        body: async (scope) => {
          executionCount++;
          const x = await scope.x;
          await delay(30);
          return { y: x * 10 };
        },
      });

      const results: any[] = [];
      system.observe('y' as VariableId, (res) => {
        if (res.type === 'success') {
          results.push(res.value);
        }
      });

      await delay(15);

      // 第一次更新 → abort 第一次执行，启动第二次
      system.updateSource('x' as VariableId, 2);

      await delay(15);

      // 第二次更新 → abort 第二次执行，启动第三次
      system.updateSource('x' as VariableId, 3);

      await delay(60);

      // 验证：多次执行，但只有最后一次的结果
      expect(executionCount).toBeGreaterThanOrEqual(2);
      expect(results.length).toBe(1);
      expect(results[0]).toBe(30); // 最后的值
    });
  });
});
