import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReactiveModule } from '../../src/reactive/reactive_module';
import {VariableId} from "../../src/reactive/types";

/**
 * 测试动态依赖机制
 * 对应 TEST_CHECKLIST.md 中的 "6. 动态依赖 (Dynamic Dependencies)"
 */
describe('Dynamic Dependencies', () => {
  let system: ReactiveModule;

  beforeEach(() => {
    system = new ReactiveModule({ 
      logLevel: 'error', 
      assertInvariants: true 
    });
  });

  it('条件分支访问 (Conditional branch access)', async () => {
    // 验证 runtimeInputs 正确追踪
    // if (cond) { await scope.x } else { await scope.y }

    system.defineSource({ id: 'cond' as VariableId, initialValue: true });
    system.defineSource({ id: 'x' as VariableId, initialValue: 10 });
    system.defineSource({ id: 'y' as VariableId, initialValue: 20 });

    system.defineComputation({
      id: 'comp',
      inputs: ['cond' as VariableId, 'x' as VariableId, 'y' as VariableId],
      outputs: ['res' as VariableId],
      body: async (scope) => {
        const cond = await scope.cond;
        if (cond) {
          const x = await scope.x;
          return { res: x };
        } else {
          const y = await scope.y;
          return { res: y };
        }
      },
    });

    const callback = vi.fn();
    system.observe('res' as VariableId, (r) => {
      if (r.type === 'success') callback(r.value);
    });
    
    // 1. 初始 cond=true, 访问 x
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(callback).toHaveBeenLastCalledWith(10);
    
    // 检查内部状态 (White-box testing)
    // 应该只依赖 cond 和 x
    // 我们无法直接访问 runtimeInputs，但在 assertInvariants 开启时，如果有未声明的访问会报错（这里都声明了）
    // 下面通过行为验证

    // 2. 更新 y，因为当前只依赖 x，不应该触发重新计算
    system.updateSource('y' as VariableId, 200);
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // 结果不变，且不应触发重新计算（如果 Input Pruning 生效，且 y 不在 runtimeInputs 中）
    // 注意：updateSource 会 markDirty。但如果 y 不在 runtimeInputs 中，它不会增加 dirtyInputCount (如果实现正确)
    // 或者它不在 dependents 列表中。
    // 在 module_execution.ts 中: cleanUnusedInputs 会移除不用的依赖。
    // 所以 y.dependents 不包含 comp。
    expect(callback).toHaveBeenLastCalledWith(10);
    // 此时无法轻易 spy executeComputation 因为它是 protected 且在内部调用。
    // 但我们可以通过结果回调次数来判断，或者 updateSource 后 callback 是否被调用（如果值没变可能不调）。
    // 更好的方式：update y 导致 y.value_at 变了。如果 comp 依赖 y，它会被标记 dirty。
    // 如果 y 不在 runtimeInputs，comp 不会被标记 dirty (除非 static inputs 处理逻辑有问题)。
    
    // 3. 切换分支 cond=false
    system.updateSource('cond' as VariableId, false);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(callback).toHaveBeenLastCalledWith(200);

    // 4. 现在依赖 cond 和 y。更新 x 应该无效
    system.updateSource('x' as VariableId, 100);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(callback).toHaveBeenLastCalledWith(200);
    
    // 5. 更新 y 应该有效
    system.updateSource('y' as VariableId, 30);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(callback).toHaveBeenLastCalledWith(30);
  });

  it('未访问输入清理 (Cleanup of unaccessed inputs)', async () => {
    // 第二次执行时不再访问 x，应从 runtimeInputs 中移除
    system.defineSource({ id: 'switch' as VariableId, initialValue: 'A' });
    system.defineSource({ id: 'a' as VariableId, initialValue: 1 });
    system.defineSource({ id: 'b' as VariableId, initialValue: 2 });

    let runCount = 0;
    system.defineComputation({
      id: 'comp',
      inputs: ['switch' as VariableId, 'a' as VariableId, 'b' as VariableId],
      outputs: ['res' as VariableId],
      body: async (scope) => {
        runCount++;
        const s = await scope.switch;
        if (s === 'A') {
          return { res: await scope.a };
        } else {
          return { res: await scope.b };
        }
      },
    });

    system.observe('res' as VariableId, () => {});
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(runCount).toBe(1); // Run 1: access switch, a

    // Switch to B
    system.updateSource('switch' as VariableId, 'B');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(runCount).toBe(2); // Run 2: access switch, b. Should remove a.

    // Update a. Should NOT trigger run.
    system.updateSource('a' as VariableId, 99);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(runCount).toBe(2); // Should still be 2

    // Update b. Should trigger run.
    system.updateSource('b' as VariableId, 99);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(runCount).toBe(3);
  });

  it('动态依赖 + Input Pruning (Dynamic dependencies + Input Pruning)', async () => {
    // 只有实际访问的输入变化才触发重新执行
    // 这个测试与上一个类似，但侧重于 Input Pruning 机制
    
    system.defineSource({ id: 'mode' as VariableId, initialValue: 1 });
    system.defineSource({ id: 'data' as VariableId, initialValue: 100 });
    
    let execCount = 0;
    system.defineComputation({
      id: 'processor',
      inputs: ['mode' as VariableId, 'data' as VariableId],
      outputs: ['out' as VariableId],
      body: async (scope) => {
        execCount++;
        const m = await scope.mode;
        // 如果 mode=1，不访问 data
        if (m === 1) {
            return { out: 'idle' };
        }
        // 如果 mode=2，访问 data
        const d = await scope.data;
        return { out: d };
      }
    });
    
    system.observe('out' as VariableId, () => {});
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(execCount).toBe(1);
    
    // 1. 当前只依赖 mode。更新 data，不应触发执行
    system.updateSource('data' as VariableId, 200);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(execCount).toBe(1);
    
    // 2. 更新 mode=2。触发执行。
    system.updateSource('mode' as VariableId, 2);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(execCount).toBe(2);
    
    // 3. 现在依赖 mode 和 data。更新 data，触发执行。
    system.updateSource('data' as VariableId, 300);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(execCount).toBe(3);
    
    // 4. 更新 mode=1。触发执行。清理 data 依赖。
    system.updateSource('mode' as VariableId, 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(execCount).toBe(4);
    
    // 5. 再次更新 data。不应触发执行。
    system.updateSource('data' as VariableId, 400);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(execCount).toBe(4);
  });

  it('静态输入边界 (Static input boundary)', async () => {
    // 动态访问的变量必须在 staticInputs 中（否则报错）
    system.defineSource({ id: 'x' as VariableId, initialValue: 1 });
    system.defineSource({ id: 'y' as VariableId, initialValue: 2 });
    
    // y 未在 inputs 中声明
    system.defineComputation({
      id: 'comp',
      inputs: ['x' as VariableId], 
      outputs: ['res' as VariableId],
      body: async (scope) => {
        const x = await scope.x;
        // 尝试访问未声明的 y
        const y = await scope.y; 
        return { res: x + y };
      }
    });

    const errorSpy = vi.fn();
    try {
        system.observe('res' as VariableId, (r) => {
            if (r.type === 'error') {
                errorSpy(r.error);
            }
        });
        await new Promise(resolve => setTimeout(resolve, 10));
    } catch (e) {
        // executeComputation 可能会捕获并设为 error result，也可能直接抛出（如果是同步部分）
        // 但这里是 async body，应该是 Result type=error
    }
    
    // 验证是否收到了错误
    // 错误信息可能包含 "not in staticInputs"
    expect(errorSpy).toHaveBeenCalled();
    const error = errorSpy.mock.calls[0][0];
    // 根据 INV-C1 或代码逻辑，这应该抛出错误
    // 目前代码中可能有 FIXME，如果没实现检查，这个测试会失败（即能成功访问）
    // 我们期望它失败，或者至少如果有 assertInvariants 会失败
    
    // 注意：如果是 assertInvariants=true (beforeEach设置了)，INV-C1 check 会在 Computation.ts 中抛出
    // 但这个是在 execution 结束后检查。
    // 实际上 handleDirectVariableAccess 应该在访问时就检查。
    // 如果没有检查，那么至少 assertInvariantC1 会抛出。
    
    // 如果实现正确，应该包含相关错误信息
    expect(error.message).toMatch(/not in staticInputs/i);
  });
});
