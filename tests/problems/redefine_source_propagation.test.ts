import { describe, it, expect, vi } from 'vitest';
import { ReactiveModule } from '../../src/reactive/reactive_module';

describe('Source Redefinition Propagation', () => {
  it('should propagate changes when source is updated via updateSource', async () => {
    const module = new ReactiveModule();
    const observerFn = vi.fn();

    // 1. Define Source x = 1
    module.defineSource({ id: 'x' as any, initialValue: 1 });

    // 2. Define Computation y = x * 2
    module.defineComputation({
      id: 'y',
      inputs: ['x' as any],
      outputs: ['y' as any],
      body: async (scope) => {
        const x = await scope.x;
        return { y: x * 2 };
      }
    });

    // 3. Observe y
    module.observe('y' as any, observerFn);

    // Initial check (async)
    // Wait for initial propagation
    await new Promise(resolve => setTimeout(resolve, 10));
    
    expect(observerFn).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'success',
      value: 2
    }));

    // 4. Update Source x = 2
    module.updateSource('x' as any, 2);

    // Wait for propagation
    await new Promise(resolve => setTimeout(resolve, 10));

    // 5. Check y is changed
    expect(observerFn).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'success',
      value: 4
    }));
    
    // Debug output
    if (observerFn.mock.calls.length !== 2) {
        console.log('Observer calls:', JSON.stringify(observerFn.mock.calls, null, 2));
    }

    // Ensure it was called twice (initial + update)
    expect(observerFn).toHaveBeenCalledTimes(2);
  });

  it('should propagate changes when source is redefined via defineSource', async () => {
    const module = new ReactiveModule();
    const observerFn = vi.fn();

    // 1. Define Source x = 1
    module.defineSource({ id: 'x' as any, initialValue: 1 });

    // 2. Define Computation y = x * 2
    module.defineComputation({
      id: 'y',
      inputs: ['x' as any],
      outputs: ['y' as any],
      body: async (scope) => {
        const x = await scope.x;
        return { y: x * 2 };
      }
    });

    module.observe('y' as any, observerFn);

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(observerFn).toHaveBeenLastCalledWith(expect.objectContaining({ value: 2 }));

    // 3. Redefine Source x = 2
    // allowRedefinition: true is required
    module.defineSource({ id: 'x' as any, initialValue: 2 }, { allowRedefinition: true });

    await new Promise(resolve => setTimeout(resolve, 10));

    // 4. Check y is changed
    expect(observerFn).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'success',
      value: 4
    }));
  });

  it('should propagate changes through multiple layers when multiple sources are removed and redefined', async () => {
    const module = new ReactiveModule();
    const observerFn = vi.fn();

    // 1. Define Source x1=1, x2=1
    module.defineSource({ id: 'x1' as any, initialValue: 1 });
    module.defineSource({ id: 'x2' as any, initialValue: 1 });

    // 2. Define Computation y = x1 * 2
    module.defineComputation({
      id: 'y',
      inputs: ['x1' as any],
      outputs: ['y' as any],
      body: async (scope) => ({ y: (await scope.x1) * 2 })
    });

    // 3. Define Computation z = y + x2
    module.defineComputation({
      id: 'z',
      inputs: ['y' as any, 'x2' as any],
      outputs: ['z' as any],
      body: async (scope) => ({ z: (await scope.y) + (await scope.x2) })
    });

    // 4. Observe z
    module.observe('z' as any, observerFn);

    // Initial Wait
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // Initial check: z = 1*2 + 1 = 3
    expect(observerFn).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'success',
      value: 3
    }));

    module.removeSource('x1' as any);
    module.removeSource('x2' as any);

    // 5. Redefine Source x1=2, x2=3
    // Using updateSource for simulating value changes
    module.defineSource({ id: 'x1' as any, initialValue: 2 }, { allowRedefinition: true });
    module.defineSource({ id: 'x2' as any, initialValue: 3 }, { allowRedefinition: true });

    // Wait for propagation
    await new Promise(resolve => setTimeout(resolve, 10));

    // 6. Check z changed: z = 2*2 + 3 = 7
    expect(observerFn).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'success',
      value: 7
    }));
  });

  it('should handle removeComputation followed by defineComputation', async () => {
    const module = new ReactiveModule();
    const observerFn = vi.fn();

    // 1. Define x = 1, y = x * 2
    module.defineSource({ id: 'x' as any, initialValue: 1 });
    module.defineComputation({
      id: 'comp_y',
      inputs: ['x' as any],
      outputs: ['y' as any],
      body: async (scope) => ({ y: (await scope.x) * 2 })
    });

    // Initial check
    module.observe('y' as any, observerFn);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(observerFn).toHaveBeenLastCalledWith(expect.objectContaining({ value: 2 }));

    // 2. Remove computation
    module.removeComputation('comp_y');
    
    // Verify it's gone
    expect(() => module.getComputationStatus('comp_y')).toThrow();

    // 3. Define computation again with different logic (y = x * 3)
    module.defineComputation({
      id: 'comp_y',
      inputs: ['x' as any],
      outputs: ['y' as any],
      body: async (scope) => ({ y: (await scope.x) * 3 })
    });

    // We need to re-observe because the old variable 'y' was deleted 
    // and a new one was created.
    const observerFn2 = vi.fn();
    module.observe('y' as any, observerFn2);

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(observerFn2).toHaveBeenLastCalledWith(expect.objectContaining({ 
      type: 'success',
      value: 3 
    }));

    // 4. Update source and check propagation
    module.updateSource('x' as any, 2);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(observerFn2).toHaveBeenLastCalledWith(expect.objectContaining({ 
      type: 'success',
      value: 6 
    }));
  });
});