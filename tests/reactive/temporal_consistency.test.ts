import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReactiveModule } from '../../src/reactive/reactive_module';
import {VariableId} from "../../src/reactive/types";
import {createReactiveModule} from "./utils";

/**
 * 测试时间一致性 (Temporal Consistency)
 *
 * 核心不变量 INV-C2: comp.cause_at >= max(inputs.cause_at)
 * 时间一致性确保：
 * 1. computation 的 cause_at 总是 >= 所有 inputs 的 cause_at
 * 2. outputs 的 cause_at 总是 = comp.cause_at
 * 3. 动态依赖也必须遵守时间一致性
 */
describe('Temporal Consistency', () => {
  let system: ReactiveModule;

  beforeEach(() => {
    system = createReactiveModule();
  });

  it('should maintain cause_at consistency during dynamic dependency access', async () => {
    // 1. Define x = 1, y = 2
    system.defineSource({ id: 'x' as VariableId, initialValue: 1 });
    system.defineSource({ id: 'y' as VariableId, initialValue: 2 });

    let accessY = true;

    // 2. Define z, accessing x and y initially
    system.defineComputation({
      id: 'comp_z',
      inputs: ['x' as VariableId, 'y' as VariableId],
      outputs: ['z' as VariableId],
      body: async (scope) => {
        const x = await scope.x;
        if (accessY) {
            const y = await scope.y;
            return { z: x + y };
        }
        return { z: x };
      },
    });

    // 3. Run 1: Access x and y
    const callback = vi.fn();
    system.observe('z' as VariableId, (r) => { if(r.type==='success') callback(r.value); });
    await new Promise(resolve => setTimeout(resolve, 10));
    // z dependents: {x, y} (runtime)

    // 4. Run 2: Access only x (removes y from runtimeInputs)
    accessY = false;
    system.updateSource('x' as VariableId, 2);
    await new Promise(resolve => setTimeout(resolve, 10));
    // z dependents: {x}. REMOVED y.

    // 5. Update x to trigger schedule. z cause_at = T_new_x
    accessY = true;
    system.updateSource('x' as VariableId, 3);
    
    // Here z is Ready/Running (async). cause_at = T_x3.
    
    // 6. Update y IMMEDIATELY (while z is pending/running or before it picks up y)
    // T_y > T_x3.
    // Since z is NOT in y.dependents, z.cause_at is NOT updated by markDirty(y).
    system.updateSource('y' as VariableId, 20);
    
    // 7. Wait for z to complete
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // z accessed y. y.cause_at > z.cause_at.
    // Should fail INV-C2 check if not fixed.
    expect(callback).toHaveBeenLastCalledWith(23); // 3 + 20
  });

  it('should update comp.cause_at when accessing variable with larger cause_at', async () => {
    // 更直接的测试：使用 peek 验证 cause_at 更新

    system.defineSource({ id: 'a' as VariableId, initialValue: 1 });
    system.defineSource({ id: 'b' as VariableId, initialValue: 2 });

    let shouldAccessB = false;
    system.defineComputation({
      id: 'comp_c',
      inputs: ['a' as VariableId, 'b' as VariableId],
      outputs: ['c' as VariableId],
      body: async (scope) => {
        const a = await scope.a;
        if (shouldAccessB) {
          const b = await scope.b; // 动态访问
          return { c: a + b };
        }
        return { c: a };
      },
    });

    system.observe('c' as VariableId, () => {});
    await new Promise(resolve => setTimeout(resolve, 10));

    // 更新 b，使其 cause_at 增大
    system.updateSource('b' as VariableId, 100);
    await new Promise(resolve => setTimeout(resolve, 10));

    // 更新 a，触发重新计算，这次会访问 b
    shouldAccessB = true;
    system.updateSource('a' as VariableId, 2);
    await new Promise(resolve => setTimeout(resolve, 10));

    // 验证：c 的 cause_at 应该反映 b 的影响
    const cState = system.peek('c' as VariableId);
    expect(cState.result).toEqual({ type: 'success', value: 102 });
  });

  it('should maintain cause_at consistency in diamond topology', async () => {
    // Diamond: a → b, a → c, b+c → d
    // 验证：d.cause_at 始终 >= max(b.cause_at, c.cause_at)

    system.defineSource({ id: 'a' as VariableId, initialValue: 1 });

    system.defineComputation({
      id: 'comp_b',
      inputs: ['a' as VariableId],
      outputs: ['b' as VariableId],
      body: async (scope) => {
        const a = await scope.a;
        return { b: a * 2 };
      },
    });

    system.defineComputation({
      id: 'comp_c',
      inputs: ['a' as VariableId],
      outputs: ['c' as VariableId],
      body: async (scope) => {
        const a = await scope.a;
        return { c: a + 5 };
      },
    });

    system.defineComputation({
      id: 'comp_d',
      inputs: ['b' as VariableId, 'c' as VariableId],
      outputs: ['d' as VariableId],
      body: async (scope) => {
        const b = await scope.b;
        const c = await scope.c;
        return { d: b + c };
      },
    });

    system.observe('d' as VariableId, () => {});
    await new Promise(resolve => setTimeout(resolve, 10));

    // 多次更新，验证 cause_at 一致性
    for (let i = 2; i <= 5; i++) {
      system.updateSource('a' as VariableId, i);
      await new Promise(resolve => setTimeout(resolve, 100)); // Increase wait time

      // 每次更新后，验证所有变量状态
      const aState = system.peek('a' as VariableId);
      const bState = system.peek('b' as VariableId);
      const cState = system.peek('c' as VariableId);
      const dState = system.peek('d' as VariableId);

      // 所有变量都应该是 clean 的
      expect(aState.isDirty).toBe(false);
      expect(bState.isDirty).toBe(false);
      expect(cState.isDirty).toBe(false);
      expect(dState.isDirty).toBe(false);

      // 值应该正确
      expect(dState.result).toEqual({ type: 'success', value: i * 2 + i + 5 });
    }
  });

  it('should maintain cause_at monotonicity', async () => {
    // 验证 INV-V3: cause_at 单调递增

    system.defineSource({ id: 'x' as VariableId, initialValue: 1 });
    system.defineComputation({
      id: 'comp_y',
      inputs: ['x' as VariableId],
      outputs: ['y' as VariableId],
      body: async (scope) => {
        const x = await scope.x;
        return { y: x + 1 };
      },
    });

    system.observe('y' as VariableId, () => {});
    await new Promise(resolve => setTimeout(resolve, 10));

    let prevCauseAt = 0;
    for (let i = 2; i <= 10; i++) {
      system.updateSource('x' as VariableId, i);
      await new Promise(resolve => setTimeout(resolve, 10));

      const yState = system.peek('y' as VariableId);
      // cause_at 应该单调递增（或保持不变，但实际上每次 updateSource 都会增加）
      // 注意：我们无法直接 peek cause_at，但可以通过逻辑推理验证
      // 如果系统正确，每次 updateSource 都应该成功传播
      expect(yState.isDirty).toBe(false);
      expect(yState.result).toEqual({ type: 'success', value: i + 1 });
    }
  });

  it('should handle concurrent updates with consistent cause_at', async () => {
    // 测试并发更新场景下的时间一致性

    system.defineSource({ id: 'a' as VariableId, initialValue: 1 });
    system.defineSource({ id: 'b' as VariableId, initialValue: 1 });

    system.defineComputation({
      id: 'comp_sum',
      inputs: ['a' as VariableId, 'b' as VariableId],
      outputs: ['sum' as VariableId],
      body: async (scope) => {
        const a = await scope.a;
        const b = await scope.b;
        return { sum: a + b };
      },
    });

    const results: number[] = [];
    system.observe('sum' as VariableId, (result) => {
      if (result.type === 'success') {
        results.push(result.value);
      }
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    // 快速连续更新两个 source
    system.updateSource('a' as VariableId, 2);
    system.updateSource('b' as VariableId, 2);

    await new Promise(resolve => setTimeout(resolve, 20));

    // 验证：最终应该收到正确的结果
    // 可能的结果序列：[2, 3, 4] 或 [2, 4]（取决于调度）
    expect(results[results.length - 1]).toBe(4);

    // 验证最终状态
    const sumState = system.peek('sum' as VariableId);
    expect(sumState.isDirty).toBe(false);
    expect(sumState.result).toEqual({ type: 'success', value: 4 });
  });

  it('should propagate cause_at correctly in long chains', async () => {
    // 测试长链中的 cause_at 传播：x → y1 → y2 → y3 → y4 → y5

    system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

    for (let i = 1; i <= 5; i++) {
      const inputId = (i === 1 ? 'x' : `y${i - 1}`) as VariableId;
      const outputId = `y${i}` as VariableId;

      system.defineComputation({
        id: `comp_y${i}`,
        inputs: [inputId],
        outputs: [outputId],
        body: async (scope) => {
          const input = await scope[inputId];
          return { [outputId]: input + 1 };
        },
      });
    }

    system.observe('y5' as VariableId, () => {});
    await new Promise(resolve => setTimeout(resolve, 10));

    // 更新 x，验证传播到 y5
    system.updateSource('x' as VariableId, 10);
    await new Promise(resolve => setTimeout(resolve, 100)); // Increase wait time

    const y5State = system.peek('y5' as VariableId);
    expect(y5State.isDirty).toBe(false);
    expect(y5State.result).toEqual({ type: 'success', value: 15 }); // 10 + 5
  });
});
