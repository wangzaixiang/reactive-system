import { describe, test, expect, beforeEach, vi } from 'vitest';
import { ReactiveModule } from '../../src/reactive/reactive_module';
import { VariableId } from '../../src/reactive/types';

describe('Problem Recovery - Redefinition', () => {
    let module: ReactiveModule;

    beforeEach(() => {
        module = new ReactiveModule({ logLevel: 'error' });
    });

    test('TC-5.1: Redefine to fix input', async () => {
        // B depends on missing A
        module.defineComputation({ id: 'B', inputs: ['A' as VariableId], outputs: ['vB' as VariableId], body: async () => ({ vB: 1 }) });
        expect(module.getProblemComputations()).toHaveLength(1);

        // Define C
        module.defineSource({ id: 'C' as VariableId, initialValue: 1 });

        // Redefine B to depend on C
        module.defineComputation({ 
            id: 'B', 
            inputs: ['C' as VariableId], 
            outputs: ['vB' as VariableId], 
            body: async (s) => ({ vB: await s.C }) 
        }, { allowRedefinition: true });

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(module.getProblemComputations()).toHaveLength(0);
    });

    test('TC-5.2: Redefine to break input', async () => {
        // B depends on A (exists)
        module.defineSource({ id: 'A' as VariableId, initialValue: 1 });
        module.defineComputation({ id: 'B', inputs: ['A' as VariableId], outputs: ['vB' as VariableId], body: async () => ({ vB: 1 }) });
        
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(module.getProblemComputations()).toHaveLength(0);

        // Redefine B to depend on missing X
        module.defineComputation({ 
            id: 'B', 
            inputs: ['X' as VariableId], 
            outputs: ['vB' as VariableId], 
            body: async () => ({ vB: 1 }) 
        }, { allowRedefinition: true });

        // Verify B becomes problem
        const problems = module.getProblemComputations();
        expect(problems.find(p => p.computationId === 'B')).toBeDefined();
        
        const probB = problems.find(p => p.computationId === 'B');
        expect(probB?.reason).toMatchObject({ type: 'missing-input', missingInputs: ['X'] });
    });

    test('TC-5.3: Redefine output (partial keep)', async () => {
        // B outputs vB1, vB2
        module.defineComputation({ 
            id: 'B', 
            inputs: [], 
            outputs: ['vB1' as VariableId, 'vB2' as VariableId], 
            body: async () => ({ vB1: 1, vB2: 2 }) 
        });

        const callback1 = vi.fn();
        module.observe('vB1' as VariableId, callback1);
        
        await new Promise(resolve => setTimeout(resolve, 10));

        // Redefine B outputs vB1, vB3
        module.defineComputation({ 
            id: 'B', 
            inputs: [], 
            outputs: ['vB1' as VariableId, 'vB3' as VariableId], 
            body: async () => ({ vB1: 10, vB3: 30 }) 
        }, { allowRedefinition: true });

        await new Promise(resolve => setTimeout(resolve, 10));

        // Verify vB1 observer is still active and got new value
        expect(callback1).toHaveBeenLastCalledWith(expect.objectContaining({ value: 10 }));

        // Verify vB2 is removed (accessing it should throw or return error depending on implementation, 
        // usually it's gone from variables map, so observe might fail)
        expect(() => module.observe('vB2' as VariableId, () => {})).toThrow(); // Assuming strict check

        // Verify vB3 exists
        const callback3 = vi.fn();
        module.observe('vB3' as VariableId, callback3);
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(callback3).toHaveBeenLastCalledWith(expect.objectContaining({ value: 30 }));
    });

    test('TC-5.4: Redefine output (all remove) triggers downstream problem', async () => {
        // B -> vB -> C
        module.defineComputation({ id: 'B', inputs: [], outputs: ['vB' as VariableId], body: async () => ({ vB: 1 }) });
        module.defineComputation({ id: 'C', inputs: ['vB' as VariableId], outputs: ['vC' as VariableId], body: async () => ({ vC: 1 }) });

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(module.getProblemComputations()).toHaveLength(0);

        // Redefine B -> vX (remove vB)
        module.defineComputation({ 
            id: 'B', 
            inputs: [], 
            outputs: ['vX' as VariableId], 
            body: async () => ({ vX: 1 }) 
        }, { allowRedefinition: true });

        // C should become problem because vB is gone
        const problems = module.getProblemComputations();
        expect(problems.find(p => p.computationId === 'C')).toBeDefined();
        
        const probC = problems.find(p => p.computationId === 'C');
        expect(probC?.reason).toMatchObject({ type: 'missing-input', missingInputs: ['vB'] });
    });
});
