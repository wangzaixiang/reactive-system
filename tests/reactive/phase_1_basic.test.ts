import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReactiveModule,} from '../../src/reactive/reactive_module';
import {VariableId, getResultValue} from "../../src/reactive/types";
import {createReactiveModule} from "./utils";

/**
 * Feature: Reactive API
 * Phase 1: Basic Scenarios Implementation
 * Task 1: Simple Chain Implementation
 */
describe('Phase 1: Basic Scenarios', () => {
  let system: ReactiveModule;

  beforeEach(() => {
    system = createReactiveModule();
  });

  it('Task 1: Simple Chain (x -> y -> z)', async () => {
    // 1. Define
    // x = 1
    system.defineSource({ id: 'x' as VariableId, initialValue: 1 });

    // y = x + 1
    system.defineComputation({
      id: 'y',
      inputs: ['x' as VariableId],
      outputs: ['y' as VariableId],
      body: async (scope) => {
        const x = await scope.x;
        return { y: x + 1 };
      },
    });

    // z = y * 2
    system.defineComputation({
      id: 'z',
      inputs: ['y' as VariableId],
      outputs: ['z' as VariableId],
      body: async (scope) => {
        const y = await scope.y;
        return { z: y * 2 };
      },
    });

    // Observe z
    const callback = vi.fn();
    system.observe('z' as VariableId, result => callback( getResultValue(result) ));

    await new Promise(resolve => setTimeout(resolve, 50));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(callback).toHaveBeenLastCalledWith(4); // (1+1)*2 = 4
    await new Promise(resolve => setTimeout(resolve, 0));

    // 2. Mutation 1: x = 2
    system.updateSource('x' as VariableId, 2);

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(callback).toHaveBeenLastCalledWith(6); // (2+1)*2 = 6
    //
    // 3. Mutation 2: x = 10
    system.updateSource('x' as VariableId, 10);

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(callback).toHaveBeenLastCalledWith(22); // (10+1)*2 = 22
  });

  it('Task 2: Diamond Topology (a->b, a->c, b+c->d)', async () => {
    // 1. Define
    // a = 1
    system.defineSource({ id: 'a' as VariableId, initialValue: 1 });

    // b = a * 2
    system.defineComputation({
      id: 'b',
      inputs: ['a' as VariableId],
      outputs: ['b' as VariableId],
      body: async (scope) => {
        const a = await scope.a;
        return { b: a * 2 };
      },
    });

    // c = a + 5
    system.defineComputation({
      id: 'c',
      inputs: ['a' as VariableId],
      outputs: ['c' as VariableId],
      body: async (scope) => {
        const a = await scope.a;
        return { c: a + 5 };
      },
    });

    // d = b + c = (a * 2) + (a + 5) = 3a + 5
    // We spy on the body to verify execution count (glitch-free)
    const bodySpy = vi.fn(async (scope) => {
        const b = await scope.b;
        const c = await scope.c;
        return { d: b + c };
    });

    system.defineComputation({
      id: 'd',
      inputs: ['b' as VariableId, 'c' as VariableId],
      outputs: ['d' as VariableId],
      body: bodySpy,
    });

    // Observe d
    const callback = vi.fn();
    system.observe('d' as VariableId, result => callback( getResultValue(result) ));

    await new Promise(resolve => setTimeout(resolve, 50));
    await new Promise(resolve => setTimeout(resolve, 0));

    // Initial check: a=1 => b=2, c=6 => d=8
    expect(callback).toHaveBeenLastCalledWith(8);
    expect(bodySpy).toHaveBeenCalledTimes(1);

    // 2. Mutation 1: a = 2
    // b=4, c=7 => d=11
    system.updateSource('a' as VariableId, 2);

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(callback).toHaveBeenLastCalledWith(11);
    expect(bodySpy).toHaveBeenCalledTimes(2); // Should only execute ONCE per update

    // 3. Mutation 2: a = 5
    // b=10, c=10 => d=20
    system.updateSource('a' as VariableId, 5);

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(callback).toHaveBeenLastCalledWith(20);
    expect(bodySpy).toHaveBeenCalledTimes(3);
  });

  it('Task 3: Computation with Multiple Outputs', async () => {
    // 1. Define
    system.defineSource({ id: 'in1' as VariableId, initialValue: 2 });
    system.defineSource({ id: 'in2' as VariableId, initialValue: 3 });

    system.defineComputation({
      id: 'math_ops',
      inputs: ['in1' as VariableId, 'in2' as VariableId],
      outputs: ['sum' as VariableId, 'prod' as VariableId],
      body: async (scope) => {
        const a = await scope.in1;
        const b = await scope.in2;
        return {
          sum: a + b,
          prod: a * b
        };
      },
    });

    const sumCallback = vi.fn();
    const prodCallback = vi.fn();

    system.observe('sum' as VariableId, result => sumCallback( getResultValue(result) ));
    system.observe('prod' as VariableId, result => prodCallback( getResultValue(result) ));

    await new Promise(resolve => setTimeout(resolve, 50));

    // Initial: 2, 3 => sum=5, prod=6
    expect(sumCallback).toHaveBeenLastCalledWith(5);
    expect(prodCallback).toHaveBeenLastCalledWith(6);

    // 2. Mutation: in1 = 4
    // 4, 3 => sum=7, prod=12
    system.updateSource('in1' as VariableId, 4);

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(sumCallback).toHaveBeenLastCalledWith(7);
    expect(prodCallback).toHaveBeenLastCalledWith(12);
  });
});
