import { describe, test, expect, beforeEach, vi } from 'vitest';
import { ReactiveModule } from '../../src/reactive/reactive_module';
import { VariableId } from '../../src/reactive/types';

describe('Problem Recovery - Basic Scenarios', () => {
    let module: ReactiveModule;

    beforeEach(() => {
        module = new ReactiveModule({ logLevel: 'error' });
    });

    describe('1.1 Missing Input', () => {
        test('TC-1.1.1: Definition with missing input', () => {
            // Define B depends on missing A
            module.defineComputation({
                id: 'B',
                inputs: ['A' as VariableId],
                outputs: ['vB' as VariableId],
                body: async () => ({ vB: 1 })
            });

            // Verify B is problem
            const problems = module.getProblemComputations();
            const probB = problems.find(p => p.computationId === 'B');
            expect(probB).toBeDefined();
            expect(probB?.reason).toMatchObject({ 
                type: 'missing-input', 
                missingInputs: expect.arrayContaining(['A']) 
            });

            // Verify vB is problem variable
            const problemVars = module.getProblemVariables();
            expect(problemVars).toContain('vB');

            // Verify observe gives fatal
            const callback = vi.fn();
            module.observe('vB' as VariableId, callback);
            
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({
                type: 'fatal',
                error: expect.objectContaining({
                    kind: 'structural',
                    reason: 'missing-input'
                })
            }));
        });

        test('TC-1.1.2: Recovery from missing input', async () => {
            // 1. Define B (missing A) -> Problem
            module.defineComputation({
                id: 'B',
                inputs: ['A' as VariableId],
                outputs: ['vB' as VariableId],
                body: async (scope) => ({ vB: await scope.A + 1 })
            });

            expect(module.getProblemComputations()).toHaveLength(1);

            // 2. Define A -> Recovery
            module.defineSource({ id: 'A' as VariableId, initialValue: 10 });
            
            // Wait for recovery propagation if async
            await new Promise(resolve => setTimeout(resolve, 10));

            // Verify B is recovered
            expect(module.getProblemComputations()).toHaveLength(0);
            
            // Verify vB has value
            const callback = vi.fn();
            module.observe('vB' as VariableId, callback);
            
            // Wait for computation execution
            await new Promise(resolve => setTimeout(resolve, 10));
            
            expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({
                type: 'success',
                value: 11
            }));
        });

        test('TC-1.1.3: Remove input causes problem', async () => {
            // 1. Setup normal chain A -> B
            module.defineSource({ id: 'A' as VariableId, initialValue: 1 });
            module.defineComputation({
                id: 'B',
                inputs: ['A' as VariableId],
                outputs: ['vB' as VariableId],
                body: async (scope) => ({ vB: await scope.A + 1 })
            });

            await new Promise(resolve => setTimeout(resolve, 10));
            expect(module.getProblemComputations()).toHaveLength(0);

            // 2. Remove A
            module.removeSource('A' as VariableId);

            // 3. Verify B becomes problem
            const problems = module.getProblemComputations();
            expect(problems.find(p => p.computationId === 'B')).toBeDefined();
            
            const problemVars = module.getProblemVariables();
            expect(problemVars).toContain('vB');
        });
    });

    describe('1.2 Duplicate Output', () => {
        test('TC-1.2.1: First-win strategy', async () => {
            // 1. Define B1 -> vB (Normal)
            module.defineComputation({
                id: 'B1',
                inputs: [],
                outputs: ['vB' as VariableId],
                body: async () => ({ vB: 1 })
            });

            // 2. Define B2 -> vB (Duplicate)
            module.defineComputation({
                id: 'B2',
                inputs: [],
                outputs: ['vB' as VariableId],
                body: async () => ({ vB: 2 })
            });

            // Verify B2 is problem
            const problems = module.getProblemComputations();
            const probB2 = problems.find(p => p.computationId === 'B2');
            expect(probB2).toBeDefined();
            expect(probB2?.reason).toMatchObject({
                type: 'duplicate-output',
                conflictsWith: 'B1'
            });

            // Verify vB is still owned by B1 (value is 1)
            const callback = vi.fn();
            module.observe('vB' as VariableId, callback);
            await new Promise(resolve => setTimeout(resolve, 10));
            
            expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({
                type: 'success',
                value: 1
            }));
        });

        test('TC-1.2.2: Recovery after owner removal', async () => {
            // 1. Setup B1 (owner) and B2 (problem)
            module.defineComputation({
                id: 'B1',
                inputs: [],
                outputs: ['vB' as VariableId],
                body: async () => ({ vB: 1 })
            });
            module.defineComputation({
                id: 'B2',
                inputs: [],
                outputs: ['vB' as VariableId],
                body: async () => ({ vB: 2 })
            });

            expect(module.getProblemComputations().find(p => p.computationId === 'B2')).toBeDefined();

            // 2. Remove B1
            module.removeComputation('B1');

            // Wait for recovery
            await new Promise(resolve => setTimeout(resolve, 10));

            // Verify B2 is recovered
            const problems = module.getProblemComputations();
            expect(problems.find(p => p.computationId === 'B2')).toBeUndefined();

            // Verify vB now comes from B2 (value 2)
            const callback = vi.fn();
            module.observe('vB' as VariableId, callback);
            await new Promise(resolve => setTimeout(resolve, 10));
            
            expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({
                type: 'success',
                value: 2
            }));
        });

        test('TC-1.2.3: Multiple competitors', async () => {
            // B1 (owner), B2 (problem), B3 (problem)
            module.defineComputation({ id: 'B1', inputs: [], outputs: ['vB' as VariableId], body: async () => ({ vB: 1 }) });
            module.defineComputation({ id: 'B2', inputs: [], outputs: ['vB' as VariableId], body: async () => ({ vB: 2 }) });
            module.defineComputation({ id: 'B3', inputs: [], outputs: ['vB' as VariableId], body: async () => ({ vB: 3 }) });

            expect(module.getProblemComputations()).toHaveLength(2); // B2, B3

            // Remove B1 -> B2 should win (defined earlier)
            module.removeComputation('B1');
            await new Promise(resolve => setTimeout(resolve, 10));

            const problems = module.getProblemComputations();
            expect(problems.find(p => p.computationId === 'B2')).toBeUndefined(); // B2 recovered
            expect(problems.find(p => p.computationId === 'B3')).toBeDefined();   // B3 still problem
            
            const probB3 = problems.find(p => p.computationId === 'B3');
            expect(probB3?.reason).toMatchObject({
                type: 'duplicate-output',
                conflictsWith: 'B2' // Conflicts with new owner
            });
        });
    });
});
