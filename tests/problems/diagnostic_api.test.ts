import { describe, test, expect, beforeEach } from 'vitest';
import { ReactiveModule } from '../../src/reactive/reactive_module';
import { VariableId } from '../../src/reactive/types';

describe('Problem Recovery - Diagnostic API', () => {
    let module: ReactiveModule;

    beforeEach(() => {
        module = new ReactiveModule({ logLevel: 'error' });
    });

    test('TC-10.1: getProblemComputations', () => {
        module.defineComputation({ id: 'B', inputs: ['A' as VariableId], outputs: ['vB' as VariableId], body: async () => ({ vB: 1 }) });
        
        const problems = module.getProblemComputations();
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatchObject({
            computationId: 'B',
            reason: { type: 'missing-input', missingInputs: expect.arrayContaining(['A']) },
            affectedOutputs: expect.arrayContaining(['vB'])
        });
    });

    test('TC-10.2: getProblemVariables', () => {
        module.defineComputation({ id: 'B', inputs: ['A' as VariableId], outputs: ['vB' as VariableId], body: async () => ({ vB: 1 }) });
        
        const vars = module.getProblemVariables();
        expect(vars).toHaveLength(1);
        expect(vars).toContain('vB');
    });

    test('TC-10.3: traceProblemRoot', async () => {
        // A (missing) -> B -> C -> D
        module.defineComputation({ id: 'B', inputs: ['A' as VariableId], outputs: ['vB' as VariableId], body: async () => ({ vB: 1 }) });
        module.defineComputation({ id: 'C', inputs: ['vB' as VariableId], outputs: ['vC' as VariableId], body: async () => ({ vC: 1 }) });
        module.defineComputation({ id: 'D', inputs: ['vC' as VariableId], outputs: ['vD' as VariableId], body: async () => ({ vD: 1 }) });

        // Trace D
        const trace = module.traceProblemRoot('D');
        
        expect(trace.computationId).toBe('D');
        expect(trace.rootCause).toMatchObject({
            computationId: 'B',
            reason: { type: 'missing-input', missingInputs: expect.arrayContaining(['A']) }
        });
        
        expect(trace.upstreamProblems).toBeDefined();
        // B -> C -> D. Upstream of D is C, Upstream of C is B.
        // The implementation details of trace.upstreamProblems might vary (full path or just immediate)
        // Assuming full path based on contract "upstreamProblems?: Array<...>"
        expect(trace.upstreamProblems).toHaveLength(2); // C and B
    });

    test('TC-10.4: getGraphHealth', () => {
        // 1 normal, 1 problem chain (2 nodes)
        module.defineSource({ id: 'X' as VariableId, initialValue: 1 }); // Normal
        module.defineComputation({ id: 'Y', inputs: ['X' as VariableId], outputs: ['vY' as VariableId], body: async () => ({ vY: 1 }) }); // Normal

        module.defineComputation({ id: 'B', inputs: ['A' as VariableId], outputs: ['vB' as VariableId], body: async () => ({ vB: 1 }) }); // Problem
        module.defineComputation({ id: 'C', inputs: ['vB' as VariableId], outputs: ['vC' as VariableId], body: async () => ({ vC: 1 }) }); // Problem

        const health = module.getGraphHealth();
        
        expect(health.totalComputations).toBe(3); // Y, B, C
        expect(health.normalComputations).toBe(1); // Y
        expect(health.problemComputations).toBe(2); // B, C
        
        expect(health.rootProblems).toHaveLength(1);
        expect(health.rootProblems[0].computationId).toBe('B');
        expect(health.rootProblems[0].affectedCount).toBeGreaterThanOrEqual(1); // C is affected
    });
});
