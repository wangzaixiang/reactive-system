import { describe, it, expect, beforeEach } from 'vitest';
import { ReactiveModule } from '../../src/reactive/reactive_module';
import { createReactiveModule } from './utils';
import { VariableId } from '../../src/reactive/types';

describe('waitIdle', () => {
  let system: ReactiveModule;

  beforeEach(() => {
    system = createReactiveModule();
  });

  it('should wait for running tasks to finish', async () => {
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    system.defineSource({ id: 'x' as VariableId, initialValue: 1 });
    system.defineComputation({
      id: 'comp_y',
      inputs: ['x' as VariableId],
      outputs: ['y' as VariableId],
      body: async (scope) => {
        const x = await scope.x;
        await gate;
        return { y: x + 1 };
      },
    });

    system.observe('y' as VariableId, () => {});

    const waitPromise = system.waitIdle();
    let resolved = false;
    waitPromise.then(() => {
      resolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resolved).toBe(false);

    release();
    await waitPromise;

    const yState = system.peek('y' as VariableId);
    expect(yState.result).toEqual({ type: 'success', value: 2 });
    expect(yState.isDirty).toBe(false);
  });

  it('should resolve when only unobserved dirty computations exist', async () => {
    system.defineSource({ id: 'a' as VariableId, initialValue: 1 });
    system.defineComputation({
      id: 'comp_b',
      inputs: ['a' as VariableId],
      outputs: ['b' as VariableId],
      body: async (scope) => ({ b: (await scope.a) + 1 }),
    });

    system.updateSource('a' as VariableId, 2);

    expect(system.peek('b' as VariableId).isDirty).toBe(true);
    expect(system.isIdle()).toBe(true);

    await system.waitIdle();

    const bState = system.peek('b' as VariableId);
    expect(bState.isDirty).toBe(true);
    expect(bState.result).toEqual({ type: 'uninitialized' });
  });
});
