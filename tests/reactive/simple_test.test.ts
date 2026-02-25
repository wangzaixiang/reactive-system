import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReactiveModule } from '../../src/reactive/reactive_module';
import {createReactiveModule} from "./utils";
import {VariableId} from "../../src/reactive/types";

/**
 * 最简单的测试用例：Y = X * 2
 * 一个 input (X)，一个 computation，一个 output (Y)
 */
describe('Simple Test: Y = X * 2', () => {
  let system: ReactiveModule;

  beforeEach(() => {
    system = createReactiveModule();
  });

  it('should compute Y = X * 2', async () => {
    // 1. Define source X
    system.defineSource({id: 'X' as VariableId, initialValue: 5});

    // 2. Define computation: Y = X * 2
    system.defineComputation({
      id: 'comp_Y',
      inputs: ['X' as VariableId],
      outputs: ['Y' as VariableId],
      body: async (scope) => {
        const x = await scope.X;
        console.log(`[Computation] X = ${x}, computing Y = ${x} * 2`);
        return {Y: x * 2};
      },
    });

    // 3. Observe Y
    const callback = vi.fn();
    system.observe('Y' as VariableId, result => {
      console.log(`[Observer] Y result:`, result);
      if (result.type === 'success') {
        callback(result.value);
      }
    });

    // 4. Wait for propagation
    await new Promise(resolve => setTimeout(resolve, 100));

    // 5. Check result
    console.log(`[Test] callback called ${callback.mock.calls.length} times`);
    console.log(`[Test] callback calls:`, callback.mock.calls);
    expect(callback).toHaveBeenCalledWith(10); // 5 * 2 = 10
  });

  it('Task 1: Simple Chain x -> y -> z', async () => {
    // 1. Define
    // x = 1
    system.defineSource({id: 'x' as VariableId, initialValue: 1});

    // y = x + 1
    system.defineComputation({
      id: 'y',
      inputs: ['x' as VariableId],
      outputs: ['y' as VariableId],
      body: async (scope) => {
        const x = await scope.x;
        return {y: x + 1};
      },
    });

    // z = y * 2
    system.defineComputation({
      id: 'z',
      inputs: ['y' as VariableId],
      outputs: ['z' as VariableId],
      body: async (scope) => {
        const y = await scope.y;
        return {z: y * 2};
      },
    });

    const callback = vi.fn();
    system.observe('z' as VariableId, result => {
      if (result.type === 'success') {
        callback(result.value);
      }
    });
    await new Promise(resolve => setTimeout(resolve, 50)); // Allow propagation
    expect(callback).toHaveBeenLastCalledWith(4)

  });

})
