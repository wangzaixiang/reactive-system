import { describe, test, expect, beforeEach } from 'vitest';
import { ReactiveModule } from '../../src/reactive/reactive_module';
import { VariableId } from '../../src/reactive/types';

describe('Problem Recovery - Recursive Scenarios', () => {
    let module: ReactiveModule;

    beforeEach(() => {
        module = new ReactiveModule({ logLevel: 'error' });
    });

    describe('2.1 Recursive Marking', () => {
        test('TC-2.1.1: Chain recursive marking A -> B -> C -> D', async () => {
            // Setup chain
            module.defineSource({ id: 'A' as VariableId, initialValue: 1 });
            module.defineComputation({ id: 'B', inputs: ['A' as VariableId], outputs: ['vB' as VariableId], body: async (s) => ({ vB: await s.A }) });
            module.defineComputation({ id: 'C', inputs: ['vB' as VariableId], outputs: ['vC' as VariableId], body: async (s) => ({ vC: await s.vB }) });
            module.defineComputation({ id: 'D', inputs: ['vC' as VariableId], outputs: ['vD' as VariableId], body: async (s) => ({ vD: await s.vC }) });

            await new Promise(resolve => setTimeout(resolve, 10));
            expect(module.getProblemComputations()).toHaveLength(0);

            // Remove A
            module.removeSource('A' as VariableId);

            // Verify all become problems
            const problems = module.getProblemComputations();
            expect(problems).toHaveLength(3);
            expect(problems.map(p => p.computationId).sort()).toEqual(['B', 'C', 'D']);

            // Verify reasons
            const probB = problems.find(p => p.computationId === 'B');
            expect(probB?.reason).toMatchObject({ type: 'missing-input', missingInputs: ['A'] });

            const probC = problems.find(p => p.computationId === 'C');
            expect(probC?.reason).toMatchObject({ type: 'missing-input', missingInputs: ['vB'] }); // or depends on problem
        });

        test('TC-2.1.2: Tree recursive marking', async () => {
            // A -> B, C; B -> D, E; C -> F
            module.defineSource({ id: 'A' as VariableId, initialValue: 1 });
            
            module.defineComputation({ id: 'B', inputs: ['A' as VariableId], outputs: ['vB' as VariableId], body: async () => ({ vB: 1 }) });
            module.defineComputation({ id: 'C', inputs: ['A' as VariableId], outputs: ['vC' as VariableId], body: async () => ({ vC: 1 }) });
            
            module.defineComputation({ id: 'D', inputs: ['vB' as VariableId], outputs: ['vD' as VariableId], body: async () => ({ vD: 1 }) });
            module.defineComputation({ id: 'E', inputs: ['vB' as VariableId], outputs: ['vE' as VariableId], body: async () => ({ vE: 1 }) });
            module.defineComputation({ id: 'F', inputs: ['vC' as VariableId], outputs: ['vF' as VariableId], body: async () => ({ vF: 1 }) });

            await new Promise(resolve => setTimeout(resolve, 10));
            expect(module.getProblemComputations()).toHaveLength(0);

            // Remove A
            module.removeSource('A' as VariableId);

            // Verify all 5 computations become problems
            const problems = module.getProblemComputations();
            expect(problems).toHaveLength(5);
            expect(problems.map(p => p.computationId).sort()).toEqual(['B', 'C', 'D', 'E', 'F']);
        });

        test('TC-2.1.3: Define problem triggers downstream marking', () => {
            // Define B (problem)
            module.defineComputation({ id: 'B', inputs: ['A' as VariableId], outputs: ['vB' as VariableId], body: async () => ({ vB: 1 }) });
            
            // Define C depending on vB
            module.defineComputation({ id: 'C', inputs: ['vB' as VariableId], outputs: ['vC' as VariableId], body: async () => ({ vC: 1 }) });

            const problems = module.getProblemComputations();
            expect(problems).toHaveLength(2);
            expect(problems.find(p => p.computationId === 'C')).toBeDefined();
        });
    });

    describe('2.2 Recursive Recovery', () => {
        test('TC-2.2.1: Chain recursive recovery', async () => {
            // A (missing) -> B -> C -> D
            module.defineComputation({ id: 'B', inputs: ['A' as VariableId], outputs: ['vB' as VariableId], body: async () => ({ vB: 1 }) });
            module.defineComputation({ id: 'C', inputs: ['vB' as VariableId], outputs: ['vC' as VariableId], body: async () => ({ vC: 1 }) });
            module.defineComputation({ id: 'D', inputs: ['vC' as VariableId], outputs: ['vD' as VariableId], body: async () => ({ vD: 1 }) });

            expect(module.getProblemComputations()).toHaveLength(3);

            // Define A
            module.defineSource({ id: 'A' as VariableId, initialValue: 1 });
            await new Promise(resolve => setTimeout(resolve, 10));

            expect(module.getProblemComputations()).toHaveLength(0);
        });

        test('TC-2.2.3: Define downstream first, then upstream', async () => {
            // C depends on vB (missing)
            module.defineComputation({ id: 'C', inputs: ['vB' as VariableId], outputs: ['vC' as VariableId], body: async () => ({ vC: 1 }) });
            expect(module.getProblemComputations()).toHaveLength(1);

            // B depends on A (exists)
            module.defineSource({ id: 'A' as VariableId, initialValue: 1 });
            module.defineComputation({ id: 'B', inputs: ['A' as VariableId], outputs: ['vB' as VariableId], body: async () => ({ vB: 1 }) });
            
            await new Promise(resolve => setTimeout(resolve, 10));
            expect(module.getProblemComputations()).toHaveLength(0);
        });
    });

    describe('3. Partial Recovery', () => {
        test('TC-3.1: Multi-input partial recovery', async () => {
            // C depends on A (missing), B (missing)
            module.defineComputation({ 
                id: 'C', 
                inputs: ['A' as VariableId, 'B' as VariableId], 
                outputs: ['vC' as VariableId], 
                body: async () => ({ vC: 1 }) 
            });

            const getProbC = () => module.getProblemComputations().find(p => p.computationId === 'C');
            
            expect(getProbC()?.reason).toMatchObject({ missingInputs: expect.arrayContaining(['A', 'B']) });

            // Define A
            module.defineSource({ id: 'A' as VariableId, initialValue: 1 });
            await new Promise(resolve => setTimeout(resolve, 10));

            // C still problem, but reason updated
            expect(module.getProblemComputations()).toHaveLength(1);
            expect(getProbC()?.reason).toMatchObject({ missingInputs: expect.arrayContaining(['B']) });
            expect((getProbC()?.reason as any).missingInputs).not.toContain('A');

            // Define B
            module.defineSource({ id: 'B' as VariableId, initialValue: 1 });
            await new Promise(resolve => setTimeout(resolve, 10));

            // C recovered
            expect(module.getProblemComputations()).toHaveLength(0);
        });

        test('TC-3.2: Cascade partial recovery', async () => {
            // A -> B, X -> C (depends on B and X)
            // Initially A, X missing
            
            // B depends on A
            module.defineComputation({ id: 'B', inputs: ['A' as VariableId], outputs: ['vB' as VariableId], body: async () => ({ vB: 1 }) });
            // C depends on vB and X
            module.defineComputation({ id: 'C', inputs: ['vB' as VariableId, 'X' as VariableId], outputs: ['vC' as VariableId], body: async () => ({ vC: 1 }) });

            expect(module.getProblemComputations()).toHaveLength(2); // B, C

            // Define A -> B recovers
            module.defineSource({ id: 'A' as VariableId, initialValue: 1 });
            await new Promise(resolve => setTimeout(resolve, 10));

            // B recovered, C still problem (missing X)
            const problems = module.getProblemComputations();
            expect(problems.find(p => p.computationId === 'B')).toBeUndefined();
            
            const probC = problems.find(p => p.computationId === 'C');
            expect(probC).toBeDefined();
            // Note: vB is now available, so C is only missing X
            expect(probC?.reason).toMatchObject({ missingInputs: expect.arrayContaining(['X']) });
            expect((probC?.reason as any).missingInputs).not.toContain('vB');

            // Define X -> C recovers
            module.defineSource({ id: 'X' as VariableId, initialValue: 1 });
            await new Promise(resolve => setTimeout(resolve, 10));

            expect(module.getProblemComputations()).toHaveLength(0);
        });
    });
});
