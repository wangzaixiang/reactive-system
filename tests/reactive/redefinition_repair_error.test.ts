import { describe, it, expect, beforeEach } from 'vitest';
import { ReactiveModule } from '../../src/reactive/reactive_module';
import { VariableId, Result } from "../../src/reactive/types";
import { createReactiveModule } from "./utils";

describe('Redefinition and Repair with Error Propagation', () => {
  let system: ReactiveModule;

  beforeEach(() => {
    system = createReactiveModule({ logLevel: 'error', assertInvariants: true });
  });

  it('should propagate error when input is removed and recover when restored', async () => {
    // 1. defineComputation("cell_1", inputs = [], outputs = ["a"] , body = (scope) => { "a": 10 } )
    system.defineComputation({
      id: 'cell_1',
      inputs: [],
      outputs: ['a' as VariableId],
      body: async () => ({ a: 10 })
    });

    // defineComputation("cell_2", inputs=["a"] outputs = ["b"], body = (scope) => { const b = await scope.a * 2, return {b} }
    system.defineComputation({
      id: 'cell_2',
      inputs: ['a' as VariableId],
      outputs: ['b' as VariableId],
      body: async (scope) => {
        const a = await scope.a;
        return { b: a * 2 };
      }
    });

    // 2. observe(b) 期望 20
    const results: Result<any>[] = [];
    system.observe('b' as VariableId, (result) => {
      results.push(result);
    });

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(results[results.length - 1]).toEqual({ type: 'success', value: 20 });

    // 3. defineComputation("cell_1", inputs = [], outputs = ["a1"] , body = (scope) => { "a1": 10 }, {allowRedefinition: true} )
    system.defineComputation({
      id: 'cell_1',
      inputs: [],
      outputs: ['a1' as VariableId],
      body: async () => ({ a1: 10 })
    }, { allowRedefinition: true });

    // 4. b 的值应该变为 { type: "error", error: "invalid computation, inputs ['a'] not exist" }
    await new Promise(resolve => setTimeout(resolve, 50));
    const lastResult = results[results.length - 1];
    expect(lastResult.type).toBe('fatal');
    if (lastResult.type === "fatal") {
      expect(lastResult.error.reason).toBe("missing-input");
    }

    // 5. defineComputation("cell_1", inputs = [], outputs = ["a"], body = (scope) => { "a": 1 }, {allowRedefinition: true});
    system.defineComputation({
      id: 'cell_1',
      inputs: [],
      outputs: ['a' as VariableId],
      body: async () => ({ a: 1 })
    }, { allowRedefinition: true });

    // 6. b 的值重新有效，期望为 2
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(results[results.length - 1]).toEqual({ type: 'success', value: 2 });
  });

  it('should handle cascading errors and recovery in a 5-cell complex graph', async () => {
    // Cell1: export const a = 10;
    system.defineComputation({ id: 'cell_1', inputs: [], outputs: ['a' as VariableId], body: async () => ({ a: 10 }) });
    // Cell2: export const b = a * 2;
    system.defineComputation({ id: 'cell_2', inputs: ['a' as VariableId], outputs: ['b' as VariableId], body: async (scope) => ({ b: (await scope.a) * 2 }) });
    // Cell3: export const c = { a, b }
    system.defineComputation({ id: 'cell_3', inputs: ['a' as VariableId, 'b' as VariableId], outputs: ['c' as VariableId], body: async (scope) => ({ c: { a: await scope.a, b: await scope.b } }) });
    // Cell4: export const d = { b }
    system.defineComputation({ id: 'cell_4', inputs: ['b' as VariableId], outputs: ['d' as VariableId], body: async (scope) => ({ d: { b: await scope.b } }) });
    // Cell5: export const text = b * 10;
    system.defineComputation({ id: 'cell_5', inputs: ['b' as VariableId], outputs: ['text' as VariableId], body: async (scope) => ({ text: (await scope.b) * 10 }) });

    // Observe all outputs
    const results = {
      b: [] as Result<any>[],
      c: [] as Result<any>[],
      d: [] as Result<any>[],
      text: [] as Result<any>[]
    };
    system.observe('b' as VariableId, r => results.b.push(r));
    system.observe('c' as VariableId, r => results.c.push(r));
    system.observe('d' as VariableId, r => results.d.push(r));
    system.observe('text' as VariableId, r => results.text.push(r));

    await new Promise(resolve => setTimeout(resolve, 100));
    expect(results.b[results.b.length - 1]).toEqual({ type: 'success', value: 20 });
    expect(results.c[results.c.length - 1]).toEqual({ type: 'success', value: { a: 10, b: 20 } });
    expect(results.d[results.d.length - 1]).toEqual({ type: 'success', value: { b: 20 } });
    expect(results.text[results.text.length - 1]).toEqual({ type: 'success', value: 200 });

    // 1. redefine Cell1: export const a1 = 10; ==> Cell2/Cell3/Cell4/Cell5 都错误
    system.defineComputation({ id: 'cell_1', inputs: [], outputs: ['a1' as VariableId], body: async () => ({ a1: 10 }) }, { allowRedefinition: true });

    await new Promise(resolve => setTimeout(resolve, 100));
    ['b', 'c', 'd', 'text'].forEach(key => {
      const last = results[key as keyof typeof results][results[key as keyof typeof results].length - 1];
      expect(last.type, `Cell ${key} should be fatal`).toBe('fatal');
    });

    // 2. redefien Cell1: export const a = 10; ==> Cell2/Cell3/Cell4/Cell5 恢复正常。
    system.defineComputation({ id: 'cell_1', inputs: [], outputs: ['a' as VariableId], body: async () => ({ a: 10 }) }, { allowRedefinition: true });

    await new Promise(resolve => setTimeout(resolve, 100));
    expect(results.b[results.b.length - 1]).toEqual({ type: 'success', value: 20 });
    expect(results.c[results.c.length - 1]).toEqual({ type: 'success', value: { a: 10, b: 20 } });
    expect(results.d[results.d.length - 1]).toEqual({ type: 'success', value: { b: 20 } });
    expect(results.text[results.text.length - 1]).toEqual({ type: 'success', value: 200 });
  });

  it('should handle cascading errors and recovery when intermediate Cell2 is redefined', async () => {
    // Setup initial healthy state
    system.defineComputation({ id: 'cell_1', inputs: [], outputs: ['a' as VariableId], body: async () => ({ a: 10 }) });
    system.defineComputation({ id: 'cell_2', inputs: ['a' as VariableId], outputs: ['b' as VariableId], body: async (scope) => ({ b: (await scope.a) * 2 }) });
    system.defineComputation({ id: 'cell_3', inputs: ['a' as VariableId, 'b' as VariableId], outputs: ['c' as VariableId], body: async (scope) => ({ c: { a: await scope.a, b: await scope.b } }) });
    system.defineComputation({ id: 'cell_4', inputs: ['b' as VariableId], outputs: ['d' as VariableId], body: async (scope) => ({ d: { b: await scope.b } }) });
    system.defineComputation({ id: 'cell_5', inputs: ['b' as VariableId], outputs: ['text' as VariableId], body: async (scope) => ({ text: (await scope.b) * 10 }) });

    const results = {
      b: [] as Result<any>[],
      c: [] as Result<any>[],
      d: [] as Result<any>[],
      text: [] as Result<any>[]
    };
    system.observe('b' as VariableId, r => results.b.push(r));
    system.observe('c' as VariableId, r => results.c.push(r));
    system.observe('d' as VariableId, r => results.d.push(r));
    system.observe('text' as VariableId, r => results.text.push(r));

    await new Promise(resolve => setTimeout(resolve, 100));
    expect(results.b[results.b.length - 1]).toEqual({ type: 'success', value: 20 });

    console.log('--- Step 1: Redefining Cell2 to fail ---');
    // 1. redefine Cell2: export const b = a1 * 2; => Cell2/3/4/5 都错误。
    // (a1 is undefined)
    system.defineComputation({ 
      id: 'cell_2', 
      inputs: ['a1' as VariableId], 
      outputs: ['b' as VariableId], 
      body: async (scope) => ({ b: (await scope.a1) * 2 }) 
    }, { allowRedefinition: true });

    await new Promise(resolve => setTimeout(resolve, 100));
    ['b', 'c', 'd', 'text'].forEach(key => {
      const last = results[key as keyof typeof results][results[key as keyof typeof results].length - 1];
      expect(last.type, `Cell ${key} should be error when cell_2 has missing input`).toBe('fatal');
    });

    console.log('--- Step 2: Redefining Cell2 to recover ---');
    // 2. redefine Cell2: export const b = a * 2 => Cell2/3/4/5 恢复正常。
    const status = system.defineComputation({ 
      id: 'cell_2', 
      inputs: ['a' as VariableId], 
      outputs: ['b' as VariableId], 
      body: async (scope) => ({ b: (await scope.a) * 2 }) 
    }, { allowRedefinition: true });
    console.log('--- Step 2: status ---', JSON.stringify(status));

    await new Promise(resolve => setTimeout(resolve, 100));
    expect(results.b[results.b.length - 1]).toEqual({ type: 'success', value: 20 });
    expect(results.c[results.c.length - 1]).toEqual({ type: 'success', value: { a: 10, b: 20 } });
    expect(results.d[results.d.length - 1]).toEqual({ type: 'success', value: { b: 20 } });
    expect(results.text[results.text.length - 1]).toEqual({ type: 'success', value: 200 });
  });
});