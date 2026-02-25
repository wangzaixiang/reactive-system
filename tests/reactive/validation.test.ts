import { describe, it, expect, beforeEach } from 'vitest';
import { ReactiveModule } from '../../src/reactive/reactive_module';
import {VariableId} from "../../src/reactive/types";
import {createReactiveModule} from "./utils";

/**
 * 测试输入验证逻辑
 */
describe('Input Validation', () => {
  let system: ReactiveModule;

  beforeEach(() => {
    system = createReactiveModule();
  });

  it('should mark problematic when computation references undefined input', () => {
    const status = system.defineComputation({
      id: 'comp_bad',
      inputs: ['undefined_var' as VariableId],
      outputs: ['output' as VariableId],
      body: async (scope) => {
        const x = await scope.undefined_var;
        return { output: x };
      },
    });

    expect(status.status).toBe('problematic');
    expect(status.problems.some(p => p.type === 'undefined_input')).toBe(true);

    // system-level problem should be visible
    expect(system.getProblems().some(p => p.entityId === 'comp_bad')).toBe(true);
    expect(system.getComputationStatus('comp_bad').status).toBe('problematic');
  });

  it('should mark problematic when computation references multiple undefined inputs', () => {
    // Define one variable
    system.defineSource({ id: 'a' as VariableId, initialValue: 1 });

    const status = system.defineComputation({
      id: 'comp_bad',
      inputs: ['a' as VariableId, 'b' as VariableId, 'c' as VariableId],
      outputs: ['output' as VariableId],
      body: async (scope) => {
        const a = await scope.a;
        const b = await scope.b;
        const c = await scope.c;
        return { output: a + b + c };
      },
    });

    expect(status.status).toBe('problematic');
    const p = status.problems.find(p => p.type === 'undefined_input');
    expect(p && p.type === 'undefined_input' ? p.undefinedInputs : []).toEqual(['b' as VariableId, 'c' as VariableId]);
  });

  it('should succeed when all inputs are defined', () => {
    // Define all required inputs
    system.defineSource({ id: 'x' as VariableId, initialValue: 1 });
    system.defineSource({ id: 'y' as VariableId, initialValue: 2 });

    const status = system.defineComputation({
      id: 'comp_good',
      inputs: ['x' as VariableId, 'y' as VariableId],
      outputs: ['sum' as VariableId],
      body: async (scope) => {
        const x = await scope.x;
        const y = await scope.y;
        return { sum: x + y };
      },
    });

    expect(status.status).toBe('healthy');
  });

  it('should mark problematic for direct circular dependency', () => {
    // Try to create a computation where one variable is both input and output
    // This is a direct self-loop which should be caught immediately
    system.defineSource({ id: 'x' as VariableId, initialValue: 1 });
    const status = system.defineComputation({
      id: 'circular',
      inputs: ['x' as VariableId],
      outputs: ['x' as VariableId],
      body: async (scope) => {
        const x = await scope.x;
        return { x: x + 1 };
      },
    });

    expect(status.status).toBe('problematic');
    expect(status.problems.some(p => p.type === 'circular_dependency' || p.type === 'output_conflict')).toBe(true);
  });
});
