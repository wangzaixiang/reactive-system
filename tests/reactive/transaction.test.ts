import {describe, test, expect, vi} from "vitest";
import {createReactiveModule} from "./utils";
import {Scope, VariableId} from "../../src/reactive/types";

describe('Transaction (withTransaction)', () => {
    test('should batch updates and execute computation once', async () => {
        const system = createReactiveModule();
        const bodySpy = vi.fn(async (scope: Scope) => {
            const a = await scope.a;
            const b = await scope.b;
            return { sum: a + b };
        });

        system.defineSource({ id: 'a' as VariableId, initialValue: 1 });
        system.defineSource({ id: 'b' as VariableId, initialValue: 2 });
        system.defineComputation({
            id: 'sum_comp',
            inputs: ['a' as VariableId, 'b' as VariableId],
            outputs: ['sum' as VariableId],
            body: bodySpy
        });

        // Observe to trigger initial execution
        const unsubscribe = system.observe('sum' as VariableId, () => {});
        await new Promise(resolve => setTimeout(resolve, 0)); // Wait for initial execution

        expect(bodySpy).toHaveBeenCalledTimes(1); // Initial execution
        expect(await system.getValue('sum' as VariableId)).toBe(3);

        bodySpy.mockClear();

        // Transaction update
        await system.withTransaction(() => {
            system.updateSource('a' as VariableId, 10); // +9
            system.updateSource('b' as VariableId, 20); // +18
        });

        // Wait for microtasks
        await new Promise(resolve => setTimeout(resolve, 0));

        // Should be executed only once
        expect(bodySpy).toHaveBeenCalledTimes(1);
        expect(await system.getValue('sum' as VariableId)).toBe(30);

        unsubscribe();
    });

    test('without transaction updates cause multiple executions (usually)', async () => {
        // Comparison test
        const system = createReactiveModule();
        const bodySpy = vi.fn(async (scope: Scope) => {
            const a = await scope.a;
            const b = await scope.b;
            return { sum: a + b };
        });

        system.defineSource({ id: 'a' as VariableId, initialValue: 1 });
        system.defineSource({ id: 'b' as VariableId, initialValue: 2 });
        system.defineComputation({
            id: 'sum_comp',
            inputs: ['a' as VariableId, 'b' as VariableId],
            outputs: ['sum' as VariableId],
            body: bodySpy
        });

        const unsubscribe = system.observe('sum' as VariableId, () => {});
        await new Promise(resolve => setTimeout(resolve, 0));
        bodySpy.mockClear();

        system.updateSource('a' as VariableId, 10);
        // Wait for microtask (default behavior)
        await new Promise(resolve => setTimeout(resolve, 0));
        
        system.updateSource('b' as VariableId, 20);
        await new Promise(resolve => setTimeout(resolve, 0));

        // Executed twice
        expect(bodySpy).toHaveBeenCalledTimes(2);
        
        unsubscribe();
    });

    test('nested transactions should work', async () => {
        const system = createReactiveModule();
        const bodySpy = vi.fn(async (scope: Scope) => {
            const a = await scope.a;
            return { res: a };
        });

        system.defineSource({ id: 'a' as VariableId, initialValue: 1 });
        system.defineComputation({
            id: 'comp',
            inputs: ['a' as VariableId],
            outputs: ['res' as VariableId],
            body: bodySpy
        });

        const unsubscribe = system.observe('res' as VariableId, () => {});
        await new Promise(resolve => setTimeout(resolve, 0));
        bodySpy.mockClear();

        await system.withTransaction(async () => {
            system.updateSource('a' as VariableId, 2);
            await system.withTransaction(() => {
                system.updateSource('a' as VariableId, 3);
            });
            // Still in outer transaction, should not execute yet
        });

        await new Promise(resolve => setTimeout(resolve, 0));
        expect(bodySpy).toHaveBeenCalledTimes(1); // Only for final value
        expect(await system.getValue('res' as VariableId)).toBe(3);
        
        unsubscribe();
    });

    test('error in transaction should reset state', async () => {
        const system = createReactiveModule();
        
        try {
            await system.withTransaction(() => {
                throw new Error("Test Error");
            });
        } catch (e) {
            expect((e as Error).message).toBe("Test Error");
        }

        // Verify we can update again
        const bodySpy = vi.fn(async (scope: Scope) => {
            const a = await scope.a;
            return { res: a * 2 };
        });
        system.defineSource({ id: 'a' as VariableId, initialValue: 1 });
        system.defineComputation({
            id: 'comp',
            inputs: ['a' as VariableId],
            outputs: ['res' as VariableId],
            body: bodySpy
        });
        
        const unsubscribe = system.observe('res' as VariableId, () => {});
        await new Promise(resolve => setTimeout(resolve, 0));
        bodySpy.mockClear();
        
        system.updateSource('a' as VariableId, 2);
        await new Promise(resolve => setTimeout(resolve, 0));
        
        expect(bodySpy).toHaveBeenCalledTimes(1);
        expect(await system.getValue('res' as VariableId)).toBe(4);
        
        unsubscribe();
    });
});
