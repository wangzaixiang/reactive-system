import {describe, test, expect} from "vitest";
import {createReactiveModule} from "./utils";
import {VariableId} from "../../src/reactive/types";

describe('Diamond Topology Observe/Unobserve', () => {
    test('Diamond topology should handle observeCount correctly', async () => {
        /**
         * Topology:
         * A -> B
         * A -> C
         * B, C -> D
         * D -> E
         * D -> F
         * E, F -> G
         */
        const system = createReactiveModule();

        system.defineSource({ id: 'a' as VariableId, initialValue: 1 });

        // Level 1: B, C
        system.defineComputation({
            id: 'comp_b',
            inputs: ['a' as VariableId],
            outputs: ['b' as VariableId],
            body: async (scope) => { return { b: (await scope.a) + 1 }; }
        });
        system.defineComputation({
            id: 'comp_c',
            inputs: ['a' as VariableId],
            outputs: ['c' as VariableId],
            body: async (scope) => { return { c: (await scope.a) + 2 }; }
        });

        // Level 2: D
        system.defineComputation({
            id: 'comp_d',
            inputs: ['b' as VariableId, 'c' as VariableId],
            outputs: ['d' as VariableId],
            body: async (scope) => { return { d: (await scope.b) + (await scope.c) }; }
        });

        // Level 3: E, F
        system.defineComputation({
            id: 'comp_e',
            inputs: ['d' as VariableId],
            outputs: ['e' as VariableId],
            body: async (scope) => { return { e: (await scope.d) * 2 }; }
        });
        system.defineComputation({
            id: 'comp_f',
            inputs: ['d' as VariableId],
            outputs: ['f' as VariableId],
            body: async (scope) => { return { f: (await scope.d) * 3 }; }
        });

        // Level 4: G
        system.defineComputation({
            id: 'comp_g',
            inputs: ['e' as VariableId, 'f' as VariableId],
            outputs: ['g' as VariableId],
            body: async (scope) => { return { g: (await scope.e) + (await scope.f) }; }
        });

        // Helper to access private fields for verification (casting to any)
        const getObserveCount = (id: string) => {
            // @ts-ignore
            const v = system.variables.get(id as VariableId);
            return v ? v.observeCount : 0;
        };
        const getCompObserveCount = (id: string) => {
            // @ts-ignore
            const c = system.computations.get(id);
            return c ? c.observeCount : 0;
        };

        // Initial state: all 0
        expect(getObserveCount('a')).toBe(0);
        expect(getObserveCount('g')).toBe(0);

        // 1. Observe G
        const unsubscribeG = system.observe('g' as VariableId, () => {});
        await new Promise(resolve => setTimeout(resolve, 0));

        // Verify counts
        // G has 1 observer
        expect(getObserveCount('g')).toBe(1);
        expect(getCompObserveCount('comp_g')).toBe(1); // G is output of comp_g

        // E, F are inputs of comp_g
        expect(getObserveCount('e')).toBe(1);
        expect(getObserveCount('f')).toBe(1);
        expect(getCompObserveCount('comp_e')).toBe(1);
        expect(getCompObserveCount('comp_f')).toBe(1);

        // D is input of both comp_e and comp_f -> should be 2
        expect(getObserveCount('d')).toBe(2); 
        expect(getCompObserveCount('comp_d')).toBe(2);

        // B, C are inputs of comp_d -> should be 2 (propagated from comp_d=2)
        // Wait, observeCount propagation:
        // comp_d has observeCount 2.
        // It propagates 2 to runtimeInputs B and C?
        // Let's trace:
        // G+1 -> comp_g+1 -> E+1, F+1
        // E+1 -> comp_e+1 -> D+1
        // F+1 -> comp_f+1 -> D+1
        // D is now 2.
        // D+2 -> comp_d+2.
        // comp_d propagates 2 to B? YES.
        // comp_d propagates 2 to C? YES.
        expect(getObserveCount('b')).toBe(2);
        expect(getObserveCount('c')).toBe(2);
        expect(getCompObserveCount('comp_b')).toBe(2);
        expect(getCompObserveCount('comp_c')).toBe(2);

        // A is input of both comp_b and comp_c
        // comp_b(2) -> A+2
        // comp_c(2) -> A+2
        // Total A should be 4
        expect(getObserveCount('a')).toBe(4);

        // Verify value
        // a=1 -> b=2, c=3 -> d=5 -> e=10, f=15 -> g=25
        expect(await system.getValue('g' as VariableId)).toBe(25);

        // 2. Unobserve G
        unsubscribeG();
        
        // Verify all 0
        expect(getObserveCount('g')).toBe(0);
        expect(getObserveCount('e')).toBe(0);
        expect(getObserveCount('f')).toBe(0);
        expect(getObserveCount('d')).toBe(0);
        expect(getObserveCount('b')).toBe(0);
        expect(getObserveCount('c')).toBe(0);
        expect(getObserveCount('a')).toBe(0);
    });
});
