import { describe, it, expect, beforeEach } from 'vitest';
import { ReactiveModule}  from '../../src/reactive/reactive_module';
import {createReactiveModule} from "./utils";
import {VariableId} from "../../src/reactive/types";

/**
 * 测试 peek 调试函数
 */
describe('Peek Debug Function', () => {
  let system: ReactiveModule;

  beforeEach(() => {
    system = createReactiveModule();
  });

  it('should peek at variable state without triggering computation', () => {
    // 1. Define source variable
    system.defineSource({ id: 'x' as VariableId, initialValue: 5 });

    // 2. Define computation
    system.defineComputation({
      id: 'comp_y',
      inputs: ['x' as VariableId],
      outputs: ['y' as VariableId],
      body: async (scope) => {
        const x = await scope.x;
        return { y: x * 2 };
      },
    });

    // 3. Peek at x - should be clean with value 5
    const xState = system.peek('x' as VariableId);
    expect(xState.result).toEqual({ type: 'success', value: 5 });
    expect(xState.isDirty).toBe(false);

    // 4. Peek at y - should be dirty and uninitialized (no computation triggered yet)
    const yState = system.peek('y' as VariableId);
    expect(yState.result).toEqual({ type: 'uninitialized' });
    expect(yState.isDirty).toBe(true);
  });

  it('should show dirty state after updateSource', () => {
    // 1. Setup
    system.defineSource({ id: 'a' as VariableId, initialValue: 1 });
    system.defineComputation({
      id: 'comp_b',
      inputs: ['a' as VariableId],
      outputs: ['b' as VariableId],
      body: async (scope) => {
        const a = await scope.a;
        return { b: a + 10 };
      },
    });

    // 2. Initially b is dirty
    expect(system.peek('b' as VariableId).isDirty).toBe(true);

    // 3. Update source a
    system.updateSource('a' as VariableId, 2);

    // 4. Check states
    const aState = system.peek('a' as VariableId);
    expect(aState.result).toEqual({ type: 'success', value: 2 });
    expect(aState.isDirty).toBe(false); // source is always clean after update

    const bState = system.peek('b' as VariableId);
    expect(bState.isDirty).toBe(true); // b is still dirty (computation not triggered)
  });

  it('should show clean state after computation completes', async () => {
    // 1. Setup
    system.defineSource({ id: 'x' as VariableId, initialValue: 3 });
    system.defineComputation({
      id: 'comp_y',
      inputs: ['x' as VariableId],
      outputs: ['y' as VariableId],
      body: async (scope) => {
        const x = await scope.x;
        return { y: x * 3 };
      },
    });

    // 2. Trigger computation by observing
    system.observe('y' as VariableId, () => {});
    await new Promise(resolve => setTimeout(resolve, 10));

    // 3. Now y should be clean with computed value
    const yState = system.peek('y' as VariableId);
    expect(yState.result).toEqual({ type: 'success', value: 9 });
    expect(yState.isDirty).toBe(false);
  });

  it('should work with error results', async () => {
    // 1. Setup computation that throws error
    system.defineSource({ id: 'x' as VariableId, initialValue: 0 });
    system.defineComputation({
      id: 'comp_y',
      inputs: ['x' as VariableId],
      outputs: ['y' as VariableId],
      body: async (scope) => {
        const x = await scope.x;
        if (x === 0) {
          throw new Error('Division by zero');
        }
        return { y: 10 / x };
      },
    });

    // 2. Trigger computation with error-catching observer
    system.observe('y' as VariableId, (result) => {
      // Observer that catches both success and error results
      // This prevents unhandled promise rejection
    });
    await new Promise(resolve => setTimeout(resolve, 10));

    // 3. Peek should show error result
    const yState = system.peek('y' as VariableId);
    expect(yState.result.type).toBe('error');
    if (yState.result.type === 'error') {
      expect(yState.result.error?.message).toBe('Division by zero');
    }
    expect(yState.isDirty).toBe(false); // Error result is still "clean" (computation completed)
  });
});
