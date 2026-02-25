import { describe, test, expect, beforeEach } from 'vitest';
import { ReactiveModule } from '../../src/reactive/reactive_module';
import { VariableId } from '../../src/reactive/types';

describe('Problem Recovery - Edge Cases', () => {
    let module: ReactiveModule;

    beforeEach(() => {
        module = new ReactiveModule({ logLevel: 'error' });
    });

    test('TC-7.1: Empty input computation', async () => {
        module.defineComputation({ id: 'B', inputs: [], outputs: ['vB' as VariableId], body: async () => ({ vB: 1 }) });
        
        expect(module.getProblemComputations()).toHaveLength(0);
    });

    test('TC-7.2: Empty output computation (side effect)', async () => {
        module.defineSource({ id: 'A' as VariableId, initialValue: 1 });
        module.defineComputation({ id: 'B', inputs: ['A' as VariableId], outputs: [], body: async () => ({}) });
        
        expect(module.getProblemComputations()).toHaveLength(0);
    });

    test('TC-7.3: Duplicate definition without allowRedefinition', () => {
        module.defineComputation({ id: 'B', inputs: [], outputs: ['vB' as VariableId], body: async () => ({ vB: 1 }) });
        
        // Should return problematic status instead of throwing (Fault-Tolerant Design)
        const status = module.defineComputation({ id: 'B', inputs: [], outputs: ['vB' as VariableId], body: async () => ({ vB: 2 }) });
        expect(status.status).toBe('problematic');
        expect(status.problems[0].type).toBe('duplicate_definition');
    });

    test('TC-7.4: Remove non-existent variable', () => {
        // Should not throw
        expect(() => module.removeSource('NonExistent' as VariableId)).not.toThrow();
    });

    test('TC-7.5: Observe non-existent variable', () => {
        expect(() => module.observe('NonExistent' as VariableId, () => {})).toThrow();
    });
});
