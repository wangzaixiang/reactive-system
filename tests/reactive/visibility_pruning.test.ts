import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReactiveModule } from '../../src/reactive/reactive_module';
import {createReactiveModule} from "./utils";
import {VariableId} from "../../src/reactive/types";

/**
 * 测试 Visibility Pruning：
 * 未被观察的 computation 不应该执行
 */
describe('Visibility Pruning', () => {
  let system: ReactiveModule;

  beforeEach(() => {
    system = createReactiveModule();
  });

  it('should NOT execute computation without observe', async () => {
    // 1. Define source
    system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

    // 2. Define computation with spy
    const bodySpy = vi.fn(async (scope) => {
      const x = await scope.x;
      return { y: x + 1 };
    });

    system.defineComputation({
      id: 'comp_y',
      inputs: ['x' as VariableId],
      outputs: ['y' as VariableId],
      body: bodySpy,
    });

    // 3. Wait a bit to ensure no execution happens
    await new Promise(resolve => setTimeout(resolve, 10));

    // 4. Verify: computation should NOT have executed
    expect(bodySpy).toHaveBeenCalledTimes(0);

    // 5. Verify: variable y should be dirty and uninitialized
    const yState = system.peek('y' as VariableId);
    expect(yState.isDirty).toBe(true);
    expect(yState.result.type).toBe('uninitialized');
  });

  it('should execute computation when observed', async () => {
    // 1. Define source
    system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

    // 2. Define computation with spy
    const bodySpy = vi.fn(async (scope) => {
      const x = await scope.x;
      return { y: x + 1 };
    });

    system.defineComputation({
      id: 'comp_y',
      inputs: ['x' as VariableId],
      outputs: ['y' as VariableId],
      body: bodySpy,
    });

    // 3. Wait - should not execute yet
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(bodySpy).toHaveBeenCalledTimes(0);

    // 4. Add observer
    const callback = vi.fn();
    system.observe('y' as VariableId, (result) => {
      if (result.type === 'success') {
        callback(result.value);
      }
    });

    // 5. Wait for execution
    await new Promise(resolve => setTimeout(resolve, 10));

    // 6. Verify: computation should have executed once
    expect(bodySpy).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(2);

    // 7. Verify: variable y should be clean
    const yState = system.peek('y' as VariableId);
    expect(yState.isDirty).toBe(false);
    expect(yState.result).toEqual({ type: 'success', value: 2 });
  });

  it('should NOT execute unobserved intermediate computation in chain', async () => {
    // Chain: x -> y -> z
    // Only observe z, y should still execute (because z needs it)

    system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

    const ySpy = vi.fn(async (scope) => {
      const x = await scope.x;
      return { y: x + 1 };
    });

    system.defineComputation({
      id: 'comp_y',
      inputs: ['x' as VariableId],
      outputs: ['y' as VariableId],
      body: ySpy,
    });

    const zSpy = vi.fn(async (scope) => {
      const y = await scope.y;
      return { z: y * 2 };
    });

    system.defineComputation({
      id: 'comp_z',
      inputs: ['y' as VariableId],
      outputs: ['z' as VariableId],
      body: zSpy,
    });

    // Wait - nothing should execute yet
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(ySpy).toHaveBeenCalledTimes(0);
    expect(zSpy).toHaveBeenCalledTimes(0);

    // Observe only z
    const callback = vi.fn();
    system.observe('z' as VariableId, (result) => {
      if (result.type === 'success') {
        callback(result.value);
      }
    });

    await new Promise(resolve => setTimeout(resolve, 50)); // Increase wait time

    // Both y and z should have executed (y is needed by z)
    expect(ySpy).toHaveBeenCalledTimes(1);
    expect(zSpy).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(4); // (1+1)*2 = 4
  });

  it('should NOT re-execute computation after updateSource if not observed', async () => {
    system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

    const bodySpy = vi.fn(async (scope) => {
      const x = await scope.x;
      return { y: x + 1 };
    });

    system.defineComputation({
      id: 'comp_y',
      inputs: ['x' as VariableId],
      outputs: ['y' as VariableId],
      body: bodySpy,
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(bodySpy).toHaveBeenCalledTimes(0);

    // Update source - should still not execute
    system.updateSource('x' as VariableId, 2);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(bodySpy).toHaveBeenCalledTimes(0);

    // Update again - still no execution
    system.updateSource('x' as VariableId, 3);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(bodySpy).toHaveBeenCalledTimes(0);
  });

  it('should execute diamond topology only when observed', async () => {
    // Diamond: a -> b, a -> c, b+c -> d
    // Only observe d

    system.defineSource({ id: 'a' as VariableId, initialValue: 1 });

    const bSpy = vi.fn(async (scope) => {
      const a = await scope.a;
      return { b: a * 2 };
    });

    const cSpy = vi.fn(async (scope) => {
      const a = await scope.a;
      return { c: a + 5 };
    });

    const dSpy = vi.fn(async (scope) => {
      const b = await scope.b;
      const c = await scope.c;
      return { d: b + c };
    });

    system.defineComputation({
      id: 'comp_b',
      inputs: ['a' as VariableId],
      outputs: ['b' as VariableId],
      body: bSpy,
    });

    system.defineComputation({
      id: 'comp_c',
      inputs: ['a' as VariableId],
      outputs: ['c' as VariableId],
      body: cSpy,
    });

    system.defineComputation({
      id: 'comp_d',
      inputs: ['b' as VariableId, 'c' as VariableId],
      outputs: ['d' as VariableId],
      body: dSpy,
    });

    // Nothing should execute yet
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(bSpy).toHaveBeenCalledTimes(0);
    expect(cSpy).toHaveBeenCalledTimes(0);
    expect(dSpy).toHaveBeenCalledTimes(0);

    // Observe d
    const callback = vi.fn();
    system.observe('d' as VariableId, (result) => {
      if (result.type === 'success') {
        callback(result.value);
      }
    });

    await new Promise(resolve => setTimeout(resolve, 50)); // Increase wait time

    // All should have executed
    expect(bSpy).toHaveBeenCalledTimes(1);
    expect(cSpy).toHaveBeenCalledTimes(1);
    expect(dSpy).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(8); // (1*2) + (1+5) = 8
  });

  it('should execute computation with multiple outputs only if any output is observed', async () => {
    system.defineSource({ id: 'x' as VariableId, initialValue: 2 });

    const bodySpy = vi.fn(async (scope) => {
      const x = await scope.x;
      return {
        sum: x + 10,
        prod: x * 10,
      };
    });

    system.defineComputation({
      id: 'comp_math',
      inputs: ['x' as VariableId],
      outputs: ['sum' as VariableId, 'prod' as VariableId],
      body: bodySpy,
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(bodySpy).toHaveBeenCalledTimes(0);

    // Observe only sum
    const callback = vi.fn();
    system.observe('sum' as VariableId, (result) => {
      if (result.type === 'success') {
        callback(result.value);
      }
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    // Should have executed (because sum is observed)
    expect(bodySpy).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(12);

    // Both outputs should be clean now
    expect(system.peek('sum' as VariableId).isDirty).toBe(false);
    expect(system.peek('prod' as VariableId).isDirty).toBe(false);
  });

  it('should NOT call observer after unsubscribe', async () => {
      const bodySpy = vi.fn(async (scope) => {
          const val = await scope.x;
          return { y: val * 2 };
      });

      system.defineSource({ id: 'x' as VariableId, initialValue: 1 });
      system.defineComputation({
          id: 'comp_y',
          inputs: ['x' as VariableId],
          outputs: ['y' as VariableId],
          body: bodySpy
      });

      const observerSpy = vi.fn();
      const unsubscribe = system.observe('y' as VariableId, (result) => {
          if (result.type === 'success') {
              observerSpy(result.value);
          }
      });

      // Initial execution due to observe
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(bodySpy).toHaveBeenCalledTimes(1); // Initial execution: x=1 -> y=2
      expect(observerSpy).toHaveBeenCalledTimes(1); // Observer is called for initial value
      expect(observerSpy).toHaveBeenCalledWith(2); // Initial value is 2
      observerSpy.mockClear(); // Clear mock to count calls after initial value and before first update

      // First update: should trigger observer
      system.updateSource('x' as VariableId, 5);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(bodySpy).toHaveBeenCalledTimes(2); // Second execution: x=5 -> y=10
      expect(observerSpy).toHaveBeenCalledTimes(1); // Called once for value 10
      expect(observerSpy).toHaveBeenCalledWith(10);
      observerSpy.mockClear(); // Clear mock to count calls after unsubscribe

      // Unsubscribe
      unsubscribe();

      // Second update after unsubscribe: should NOT trigger observer, and compBody should NOT run
      system.updateSource('x' as VariableId, 10);
      await new Promise(resolve => setTimeout(resolve, 0));

      // Observer should NOT be called
      expect(observerSpy).not.toHaveBeenCalled();

      // Comp body should NOT have run, because nothing is observing 'y' anymore.
      expect(bodySpy).toHaveBeenCalledTimes(2); // Should still be 2, no new calls after unsubscribe

      // Verify that 'y' is dirty (dirty propagation happens regardless of observation)
      // but computation is idle (Visibility Pruning happens at scheduling layer, not propagation layer)
      expect(system.peek('y' as VariableId).isDirty).toBe(true);
      // @ts-ignore
      expect(system.computations.get('comp_y')?.state).toBe('idle');
      // @ts-ignore
      expect(system.computations.get('comp_y')?.observeCount).toBe(0);
  });
});
