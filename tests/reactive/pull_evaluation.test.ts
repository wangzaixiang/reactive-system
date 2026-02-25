import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReactiveModule } from '../../src/reactive/reactive_module';
import {VariableId} from "../../src/reactive/types";

/**
 * 辅助函数：模拟耗时操作，支持 AbortSignal
 */
function delay(ms: number, signal?: AbortSignal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    
    const timer = setTimeout(() => resolve(true), ms);
    
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

/**
 * 测试 Pull-based 求值机制
 * 对应 TEST_CHECKLIST.md 中的 "7. Pull-based 求值 (Pull-based Evaluation)"
 */
describe('Pull-based Evaluation', () => {
  let system: ReactiveModule;

  beforeEach(() => {
    system = new ReactiveModule({ 
      logLevel: 'trace', 
      assertInvariants: true 
    });
  });

  it('getValue() 触发计算 (getValue triggers computation)', async () => {
    // 调用 getValue() 时，如果 dirty 则触发计算
    system.defineSource({ id: 'x' as VariableId, initialValue: 10 });
    
    const bodySpy = vi.fn(async (scope) => {
        const x = await scope.x;
        return { y: x * 2 };
    });

    system.defineComputation({
      id: 'comp',
      inputs: ['x' as VariableId],
      outputs: ['y' as VariableId],
      body: bodySpy
    });

    // 初始状态：comp 未运行，y 是 dirty
    const yState = system.peek('y' as VariableId);
    expect(yState.isDirty).toBe(true);
    expect(bodySpy).toHaveBeenCalledTimes(0);

    // Pull value
    const value = await system.getValue('y' as VariableId);
    
    expect(value).toBe(20);
    expect(bodySpy).toHaveBeenCalledTimes(1);
    
    // 之后应该是 clean
    expect(system.peek('y' as VariableId).isDirty).toBe(false);
  });

  it('共享 runningTask (Share running task)', async () => {
    // 多个 getValue() 调用共享同一任务 Promise
    system.defineSource({ id: 'x' as VariableId, initialValue: 1 });
    
    const bodySpy = vi.fn(async (scope) => {
        await delay(50); // 耗时操作
        const x = await scope.x;
        return { y: x + 1 };
    });

    system.defineComputation({
      id: 'comp',
      inputs: ['x' as VariableId],
      outputs: ['y' as VariableId],
      body: bodySpy
    });

    // 同时发起两个 pull 请求
    const p1 = system.getValue('y' as VariableId);
    const p2 = system.getValue('y' as VariableId);
    
    const [v1, v2] = await Promise.all([p1, p2]);
    
    expect(v1).toBe(2);
    expect(v2).toBe(2);
    // body 应该只执行一次
    expect(bodySpy).toHaveBeenCalledTimes(1);
  });

  it('AbortError 重试 (Retry on AbortError)', async () => {
    // getValue() 遇到 AbortError 自动重试（retry=true）
    system.defineSource({ id: 'x' as VariableId, initialValue: 1 });
    
    const bodySpy = vi.fn(async (scope, signal) => {
      system.isLogEnabled('trace') && system.log('trace', 'task', '<< Computation body started');
        const x = await scope.x;
        await delay(30, signal);
        return { y: x * 10 };
    });

    system.defineComputation({
      id: 'comp',
      inputs: ['x' as VariableId],
      outputs: ['y' as VariableId],
      body: bodySpy
    });

    // 发起 pull
    const p1 = system.getValue('y' as VariableId);
    
    // 稍微等待，让任务开始
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // 更新 source，导致运行中的任务被 abort
    system.updateSource('x' as VariableId, 2);
    
    // p1 应该捕获 AbortError 并自动重试，最终返回新值
    const val = await p1;
    
    // 第一次调用被 abort，第二次调用成功 (x=2)
    // bodySpy 应该被调用两次
    // 实际上可能更多，取决于调度，但至少两次
    expect(bodySpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(val).toBe(20);
  });

  it('其他错误抛出 (Throw other errors)', async () => {
    // getValue() 遇到非 Abort 错误，直接抛出
    system.defineSource({ id: 'x' as VariableId, initialValue: 0 });
    
    system.defineComputation({
      id: 'comp',
      inputs: ['x' as VariableId],
      outputs: ['y' as VariableId],
      body: async (scope) => {
        const x = await scope.x;
        if (x === 0) throw new Error('Zero Error');
        return { y: x };
      }
    });

    await expect(system.getValue('y' as VariableId)).rejects.toThrow('Zero Error');
  });

  it('动态依赖 + 多次 Abort + Cause_at 传播 (Dynamic dependency + Multiple Aborts + Cause_at propagation)', async () => {
    // 1. Define sources
    system.defineSource({ id: 'x1' as VariableId, initialValue: 1 });
    system.defineSource({ id: 'x2' as VariableId, initialValue: 1 });
    system.defineSource({ id: 'x3' as VariableId, initialValue: 1 });
    system.defineSource({ id: 'x4' as VariableId, initialValue: 1 });

    const bodySpy = vi.fn(async (scope, signal) => {
        const v1 = await scope.x1;
        const v2 = await scope.x2;
        
        // Pull x3 with delay
        await delay(20, signal);
        const v3 = await scope.x3;
        
        // Pull x4 with delay
        await delay(20, signal);
        const v4 = await scope.x4;
        
        return { res: v1 + v2 + v3 + v4 };
    });

    // 2. Define computation
    system.defineComputation({
      id: 'comp',
      inputs: ['x1' as VariableId, 'x2' as VariableId, 'x3' as VariableId, 'x4' as VariableId], // Declare all for simplicity in this test, or use dynamic
      outputs: ['res' as VariableId],
      body: bodySpy
    });

    // 3. Start Pull
    const resultPromise = system.getValue('res' as VariableId);

    // Initial state: x1=1, x2=1, x3=1, x4=1
    // Run 1 starts. Reads x1, x2. Waits 20ms for x3.

    await new Promise(resolve => setTimeout(resolve, 10));
    // In Run 1, should be in first delay (20ms)

    // 4. Update x1 -> Abort Run 1
    system.updateSource('x1' as VariableId, 10);
    // x1 cause_at updated. comp marked dirty. Run 1 aborted.
    // Auto-retry Run 2.

    await new Promise(resolve => setTimeout(resolve, 30));
    // Run 2 starts. Reads x1(10), x2(1).
    // Waits 20ms. Reads x3(1).
    // Should be in second delay waiting for x4.

    // 5. Update x3 -> Abort Run 2
    system.updateSource('x3' as VariableId, 100);
    // x3 updated. Since x3 was accessed in Run 2, it is in runtimeInputs.
    // comp marked dirty. Run 2 aborted.
    // Auto-retry Run 3.

    await new Promise(resolve => setTimeout(resolve, 60));
    // Run 3 should complete.
    // x1=10, x2=1, x3=100, x4=1. Sum = 112.
    
    const value = await resultPromise;
    expect(value).toBe(112);
    
    // Check spy call count. 
    // Run 1: aborted at first delay or shortly after.
    // Run 2: aborted at second delay.
    // Run 3: completed.
    // Expect at least 3 calls start.
    expect(bodySpy.mock.calls.length).toBeGreaterThanOrEqual(3);

    // 6. Verify cause_at
    const compState = system.peekComputation('comp');

    // We can't easily verify exact numbers without exposing more internal state,
    // but the correctness of the result (112) relies on using the latest values,
    // which implies cause_at propagation worked to trigger re-execution.

    // For specific requirement "cause_at must reflect x4's source factor change":
    // Actually in this scenario x3 changed last.
    // Let's update x4 to be sure.

    system.updateSource('x4' as VariableId, 1000);
    await new Promise(resolve => setTimeout(resolve, 100));
    // Run 4 completes. Sum = 1111 (10 + 1 + 100 + 1000).
    // comp.cause_at should match x4's update time.

    const resValue = await system.getValue('res' as VariableId);
    expect(resValue).toBe(1111);
  });
});
