import { describe, test, expect, beforeEach, vi } from 'vitest';
import { ReactiveModule } from '../../src/reactive/reactive_module';
import { VariableId } from '../../src/reactive/types';

describe('Problem Recovery - Observers', () => {
    let module: ReactiveModule;

    beforeEach(() => {
        module = new ReactiveModule({ logLevel: 'error' });
    });

    test('TC-6.1: Observe problem variable', () => {
        // B depends on missing A -> vB is problem variable
        module.defineComputation({ id: 'B', inputs: ['A' as VariableId], outputs: ['vB' as VariableId], body: async () => ({ vB: 1 }) });

        const callback = vi.fn();
        module.observe('vB' as VariableId, callback);

        // Should immediately receive fatal
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({
            type: 'fatal',
            error: expect.objectContaining({ kind: 'structural' })
        }));
    });

    test('TC-6.2: Problem recovery notification', async () => {
        // B depends on missing A
        module.defineComputation({ id: 'B', inputs: ['A' as VariableId], outputs: ['vB' as VariableId], body: async () => ({ vB: 1 }) });

        const callback = vi.fn();
        module.observe('vB' as VariableId, callback);
        // module.observe('vB' as VariableId, (update) => {
        //         console.log('Observer received update:', update);
        //     }
        // );

        expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'fatal' }));

        // Define A -> Recovery
        module.defineSource({ id: 'A' as VariableId, initialValue: 1 });
        await new Promise(resolve => setTimeout(resolve, 10));

        // Should receive success/uninitialized
        // The value depends on whether B has executed.
        // It might be uninitialized first then success, or directly success if fast.
        const calls = callback.mock.calls;
        const lastCallArg = calls[calls.length - 1][0];
        
        expect(lastCallArg.type).not.toBe('fatal');
        // Ideally eventually success
        if (lastCallArg.type !== 'success') {
             await new Promise(resolve => setTimeout(resolve, 20));
             expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'success' }));
        } else {
             expect(lastCallArg.type).toBe('success');
        }
    });

    test('TC-6.3: Redefinition preserves observers', async () => {
        // B -> vB
        module.defineComputation({ id: 'B', inputs: [], outputs: ['vB' as VariableId], body: async () => ({ vB: 1 }) });

        const callback = vi.fn();
        module.observe('vB' as VariableId, callback);
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ value: 1 }));

        // Redefine B (keep vB)
        module.defineComputation({ 
            id: 'B', 
            inputs: [], 
            outputs: ['vB' as VariableId], 
            body: async () => ({ vB: 2 }) 
        }, { allowRedefinition: true });

        await new Promise(resolve => setTimeout(resolve, 10));
        
        // Observer should be called with new value
        expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ value: 2 }));
    });
});
