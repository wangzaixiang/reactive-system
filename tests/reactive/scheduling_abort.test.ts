import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReactiveModule } from '../../src/reactive/reactive_module';
import {VariableId} from "../../src/reactive/types";
import {createReactiveModule} from "./utils";

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
 * 测试调度与并发中的激进取消机制
 * 对应 TEST_CHECKLIST.md 中的 "4. 调度与并发 (Scheduling & Concurrency)" - "激进取消 (Aggressive Abort)"
 */
describe('Scheduling & Concurrency - Aggressive Abort', () => {
  let system: ReactiveModule;

  beforeEach(() => {
    system = createReactiveModule({assertInvariants: true});
  });

  it('长耗时计算中断 (Long-running computation interruption)', async () => {
    // 1. 定义源变量 x
    system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

    // 2. 定义耗时计算 y
    const executionSpy = vi.fn();
    system.defineComputation({
      id: 'y',
      inputs: ['x' as VariableId],
      outputs: ['y' as VariableId],
      body: async (scope, signal) => {
        executionSpy('start');
        const x = await scope.x;
        
        try {
          // 模拟耗时操作 (50ms)
          await delay(50, signal);
          executionSpy('complete', x);
          return { y: x * 10 };
        } catch (e: any) {
          if (e.name === 'AbortError') {
            executionSpy('aborted', x);
          }
          throw e;
        }
      },
    });

    // 3. 观察 y
    const callback = vi.fn();
    system.observe('y' as VariableId, (res) => {
      if (res.type === 'success') callback(res.value);
    });

    // 等待首次执行完成 (x=1)
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(executionSpy).toHaveBeenLastCalledWith('complete', 1);
    expect(callback).toHaveBeenLastCalledWith(10);
    executionSpy.mockClear();
    callback.mockClear();

    // 4. 更新 x = 2，触发重新计算
    system.updateSource('x' as VariableId, 2);
    
    // 此时 y 应该正在运行 (delay 50ms)
    // 稍微等待一下 (10ms)，确保 y 已经开始执行但未完成
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // 5. 立即更新 x = 3，应该中断正在进行的计算 (x=2)
    system.updateSource('x' as VariableId, 3);

    // 等待所有计算完成 (足够长的时间)
    await new Promise(resolve => setTimeout(resolve, 150));

    // 验证：
    // - 应该有一次 aborted (x=2)
    // - 应该有一次 complete (x=3)
    // - callback 应该只收到最终结果 30
    
    // 检查调用序列
    const calls = executionSpy.mock.calls.map(args => args[0]);
    expect(calls).toContain('aborted');
    expect(calls).toContain('complete');
    
    // 验证 aborted 的是 x=2
    const abortedCall = executionSpy.mock.calls.find(args => args[0] === 'aborted');
    expect(abortedCall?.[1]).toBe(2);

    // 验证 completed 的是 x=3
    const completedCall = executionSpy.mock.calls.find(args => args[0] === 'complete');
    expect(completedCall?.[1]).toBe(3);

    // 验证回调只收到最新的值
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(30);
  });

  it('新值正确传播 (New value propagation)', async () => {
    // 1. 定义源变量
    system.defineSource({ id: 'a' as VariableId, initialValue: 10 });

    // 2. 定义计算 b = a + 1 (耗时)
    system.defineComputation({
      id: 'b',
      inputs: ['a' as VariableId],
      outputs: ['b' as VariableId],
      body: async (scope, signal) => {
        const a = await scope.a;
        await delay(30, signal);
        return { b: a + 1 };
      },
    });

    // 3. 定义计算 c = b * 2
    system.defineComputation({
      id: 'c',
      inputs: ['b' as VariableId],
      outputs: ['c' as VariableId],
      body: async (scope) => {
        const b = await scope.b;
        return { c: b * 2 };
      },
    });

    const callback = vi.fn();
    system.observe('c' as VariableId, (res) => {
      if (res.type === 'success') callback(res.value);
    });

    // 初始: a=10 -> b=11 -> c=22
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(callback).toHaveBeenLastCalledWith(22);
    callback.mockClear();

    // 4. 连续更新
    system.updateSource('a' as VariableId, 20); // b start (20+1)
    await new Promise(resolve => setTimeout(resolve, 10)); // wait a bit
    system.updateSource('a' as VariableId, 30); // abort (20+1), restart (30+1)

    // 等待完成
    await new Promise(resolve => setTimeout(resolve, 200));

    // 最终结果应该是 a=30 -> b=31 -> c=62
    // 中间结果 (a=20 -> b=21 -> c=42) 不应该出现
    expect(callback).toHaveBeenLastCalledWith(62);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('中断后的状态 (State after interruption)', async () => {
    system.defineSource({ id: 'val' as VariableId, initialValue: 0 });

    let abortCount = 0;
    system.defineComputation({
      id: 'process',
      inputs: ['val' as VariableId],
      outputs: ['res' as VariableId],
      body: async (scope, signal) => {
        await scope.val;
        try {
          await delay(50, signal);
          return { res: 'done' };
        } catch (e: any) {
          if (e.name === 'AbortError') abortCount++;
          throw e;
        }
      },
    });

    // 触发执行
    system.observe('res' as VariableId, () => {});
    await new Promise(resolve => setTimeout(resolve, 100));

    // 更新触发
    system.updateSource('val' as VariableId, 1);
    await new Promise(resolve => setTimeout(resolve, 10)); // running

    // 此时 peek 状态
    // Variable 'res' 应该是 dirty 的
    const resState = system.peek('res' as VariableId);
    expect(resState.isDirty).toBe(true);

    // 中断
    system.updateSource('val' as VariableId, 2);
    
    // 立即检查：abort 信号应该已发送，但是否已完成 catch 取决于 microtask
    // 在我们的同步代码执行完后，updateSource 内部已经调用了 markDirty -> abortOutdatedTask
    // runningTask.abortController.abort() 已被调用。
    
    // 等待 microtask 以便 catch 块执行
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(abortCount).toBe(1);

    // 此时 computation 应该被重新调度进入 readyQueue
    // 我们无法直接访问 readyQueue，但可以通过结果最终正确来验证它没有丢失
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // 最终应该是 clean
    expect(system.peek('res' as VariableId).isDirty).toBe(false);
  });

  it('多次更新连续中断 (Multiple updates consecutive interruptions)', async () => {
    system.defineSource({ id: 'input' as VariableId, initialValue: 0 });

    const executionLog: number[] = [];
    system.defineComputation({
      id: 'comp',
      inputs: ['input' as VariableId],
      outputs: ['output' as VariableId],
      body: async (scope, signal) => {
        const val = await scope.input;
        try {
          await delay(20, signal);
          executionLog.push(val);
          return { output: val };
        } catch (e: any) {
            if (e.name === 'AbortError') {
                // optional: log abort
            }
            throw e;
        }
      },
    });

    system.observe('output' as VariableId, () => {});
    await new Promise(resolve => setTimeout(resolve, 50));
    executionLog.length = 0; // clear initial run

    // 快速连续更新 1, 2, 3, 4, 5
    // 每次间隔 5ms (小于执行时间 20ms)
    // 预期：1, 2, 3, 4 都会被 abort，只有 5 完成
    for (let i = 1; i <= 5; i++) {
      system.updateSource('input' as VariableId, i);
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    // 等待足够长的时间让最后一次完成
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(executionLog).toEqual([5]);
  });
});
