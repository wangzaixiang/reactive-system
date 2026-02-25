import { describe, test, expect, beforeEach } from 'vitest';
import { ReactiveModule } from '../../src/reactive/reactive_module';
import { VariableId } from '../../src/reactive/types';

describe('Problem Recovery - Circular Dependency', () => {
    let module: ReactiveModule;

    beforeEach(() => {
        module = new ReactiveModule({ logLevel: 'error' });
    });

    test('TC-4.1: Detect simple cycle A -> B -> C -> A', async () => {
        // A -> B
        module.defineComputation({ id: 'A', inputs: ['vC' as VariableId], outputs: ['vA' as VariableId], body: async () => ({ vA: 1 }) });
        // B -> C
        module.defineComputation({ id: 'B', inputs: ['vA' as VariableId], outputs: ['vB' as VariableId], body: async () => ({ vB: 1 }) });
        
        // At this point A and B are missing inputs, so they are problems (missing-input)
        
        // C -> A (closes cycle)
        module.defineComputation({ id: 'C', inputs: ['vB' as VariableId], outputs: ['vC' as VariableId], body: async () => ({ vC: 1 }) });

        // Verify all are problems with circular-dependency
        const problems = module.getProblemComputations();
        expect(problems).toHaveLength(3);

        const reasons = problems.map(p => p.reason);
        reasons.forEach(r => {
            expect(r.type).toBe('circular-dependency');
            expect((r as any).cyclePath).toBeDefined();
        });
        
        // Verify cycle path contains A, B, C
        const cyclePath = (reasons[0] as any).cyclePath;
        expect(cyclePath).toEqual(expect.arrayContaining(['A', 'B', 'C']));
    });

    test('TC-4.2: Break cycle by deleting node', async () => {
        // Setup cycle A -> B -> C -> A
        module.defineComputation({ id: 'A', inputs: ['vC' as VariableId], outputs: ['vA' as VariableId], body: async () => ({ vA: 1 }) });
        module.defineComputation({ id: 'B', inputs: ['vA' as VariableId], outputs: ['vB' as VariableId], body: async () => ({ vB: 1 }) });
        module.defineComputation({ id: 'C', inputs: ['vB' as VariableId], outputs: ['vC' as VariableId], body: async () => ({ vC: 1 }) });

        expect(module.getProblemComputations()).toHaveLength(3);

        // Remove B
        module.removeComputation('B');

        // Remaining: A depends on vC (from C), C depends on vB (missing)
        // A -> vC -> C -> vB (missing)
        
        const problems = module.getProblemComputations();
        expect(problems).toHaveLength(2); // A, C

        const probA = problems.find(p => p.computationId === 'A');
        const probC = problems.find(p => p.computationId === 'C');

        // C is missing input vB
        expect(probC?.reason).toMatchObject({ type: 'missing-input', missingInputs: ['vB'] });
        
        // A is missing input vC (wait, C exists but produces vC which is in problem_variables because C is a problem)
        // So A depends on problem
        expect(probA?.reason).toMatchObject({ type: 'missing-input', missingInputs: ['vC'] });
    });

    test('TC-4.3: Break cycle by redefinition', async () => {
        // Setup cycle A -> B -> C -> A
        module.defineComputation({ id: 'A', inputs: ['vC' as VariableId], outputs: ['vA' as VariableId], body: async () => ({ vA: 1 }) });
        module.defineComputation({ id: 'B', inputs: ['vA' as VariableId], outputs: ['vB' as VariableId], body: async () => ({ vB: 1 }) });
        module.defineComputation({ id: 'C', inputs: ['vB' as VariableId], outputs: ['vC' as VariableId], body: async () => ({ vC: 1 }) });

        // Redefine C to depend on new source X instead of vB
        module.defineSource({ id: 'X' as VariableId, initialValue: 10 });
        
        module.defineComputation({ 
            id: 'C', 
            inputs: ['X' as VariableId], 
            outputs: ['vC' as VariableId], 
            body: async (s) => ({ vC: await s.X }) 
        }, { allowRedefinition: true });

        // Now: X -> C -> vC -> A -> vA -> B -> vB
        // All should be recovered
        
        await new Promise(resolve => setTimeout(resolve, 10));
        
        expect(module.getProblemComputations()).toHaveLength(0);
    });
});
