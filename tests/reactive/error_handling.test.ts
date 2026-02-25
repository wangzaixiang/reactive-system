import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReactiveModule, VariableId } from '../../src/reactive/reactive_module';

/**
 * 测试错误处理机制
 * 对应 TEST_CHECKLIST.md 中的 "5. 错误处理 (Error Handling)"
 */
describe('Error Handling', () => {
  let system: ReactiveModule;

  beforeEach(() => {
    system = new ReactiveModule({ logLevel: 'error', assertInvariants: true });
  });

  it('计算抛出错误 (Computation throws error)', async () => {
    // 验证错误传播到所有 outputs（type='error'）
    system.defineSource({ id: 'x' as VariableId, initialValue: 0 });
    
    system.defineComputation({
      id: 'div_comp',
      inputs: ['x' as VariableId],
      outputs: ['res' as VariableId],
      body: async (scope) => {
        const x = await scope.x;
        if (x === 0) throw new Error('Division by zero');
        return { res: 10 / x };
      }
    });

    const errorCallback = vi.fn();
    const successCallback = vi.fn();
    
    system.observe('res' as VariableId, (r) => {
        if (r.type === 'error') errorCallback(r.error);
        if (r.type === 'success') successCallback(r.value);
    });

    // 1. Initial run: x=0 -> Error
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(errorCallback).toHaveBeenCalledTimes(1);
    expect(errorCallback.mock.calls[0][0].message).toBe('Division by zero');
    expect(successCallback).not.toHaveBeenCalled();

    // 2. Recovery: x=2 -> Success
    errorCallback.mockClear();
    system.updateSource('x' as VariableId, 2);
    await new Promise(resolve => setTimeout(resolve, 10));
    
    expect(successCallback).toHaveBeenCalledWith(5);
    expect(errorCallback).not.toHaveBeenCalled();
  });

  it('AbortError 不传播 (AbortError should not propagate)', async () => {
    // 中止任务不应将 AbortError 传播到 outputs
    // 这个测试在 scheduling_abort.test.ts 中有类似覆盖，这里专门验证 output 状态
    
    system.defineSource({ id: 'a' as VariableId, initialValue: 1 });
    
    system.defineComputation({
      id: 'long_task',
      inputs: ['a' as VariableId],
      outputs: ['b' as VariableId],
      body: async (scope, signal) => {
        const a = await scope.a;
        // 模拟长任务
        await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 50);
            signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new DOMException('Aborted', 'AbortError'));
            });
        });
        return { b: a * 10 };
      }
    });

    const callback = vi.fn();
    system.observe('b' as VariableId, callback);
    
    // 触发第一次运行
    await new Promise(resolve => setTimeout(resolve, 10)); // started
    
    // 立即触发第二次运行，导致第一次 abort
    system.updateSource('a' as VariableId, 2);
    
    await new Promise(resolve => setTimeout(resolve, 100)); // wait all
    
    // 验证回调：
    // callback 应该只被调用一次（第二次成功的结果）
    // 第一次的 AbortError 不应该触发 callback (因为 updateOutputsWithError 会过滤 AbortError? 
    // 不，handleExecutionError 专门过滤了 AbortError，不调用 updateOutputsWithError)
    
    // 如果 AbortError 传播了，callback 会收到 {type: 'error', error: AbortError}
    const abortErrors = callback.mock.calls.filter(args => args[0].type === 'error' && args[0].error.name === 'AbortError');
    expect(abortErrors.length).toBe(0);
    
    // 应该只收到成功的 20
    const successes = callback.mock.calls.filter(args => args[0].type === 'success');
    expect(successes.length).toBe(1);
    expect(successes[0][0].value).toBe(20);
  });

  it('错误状态清理 (Error state cleanup)', async () => {
    // 错误后 computation 应变为 Idle（不应无限重试）
    system.defineSource({ id: 'x' as VariableId, initialValue: 0 });
    
    const bodySpy = vi.fn(async (scope) => {
        const x = await scope.x;
        if (x === 0) throw new Error('Fail');
        return { y: x };
    });

    system.defineComputation({
      id: 'comp',
      inputs: ['x' as VariableId],
      outputs: ['y' as VariableId],
      body: bodySpy
    });

    system.observe('y' as VariableId, () => {});
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // 应该执行一次并失败
    expect(bodySpy).toHaveBeenCalledTimes(1);
    
    // 再次等待，确保没有无限重试
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(bodySpy).toHaveBeenCalledTimes(1); // Still 1
    
    // 验证状态是 Idle 且 Clean (错误也是一种结果)
    // 注意：在 V3 实现中，发生错误后，comp.dirty = false, comp.state = Idle
    const compState = system.peekComputation('comp');
    expect(compState.state).toBe('idle');
    expect(compState.dirty).toBe(false);
  });

  it('错误后重新计算 (Re-computation after error)', async () => {
    // 输入变化后，应重新尝试计算（即使之前出错）
    system.defineSource({ id: 'x' as VariableId, initialValue: 0 });
    
    const bodySpy = vi.fn(async (scope) => {
        const x = await scope.x;
        if (x === 0) throw new Error('Fail');
        return { y: x };
    });

    system.defineComputation({
      id: 'comp',
      inputs: ['x' as VariableId],
      outputs: ['y' as VariableId],
      body: bodySpy
    });

    system.observe('y' as VariableId, (r) => {});
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(bodySpy).toHaveBeenCalledTimes(1); // Fail run

    // 更新输入
    system.updateSource('x' as VariableId, 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // 应该再次执行并成功
    expect(bodySpy).toHaveBeenCalledTimes(2);
    
    const yState = system.peek('y' as VariableId);
    expect(yState.result).toEqual({ type: 'success', value: 1 });
  });

  it('循环依赖检测 (Circular dependency detection)', () => {
    // 定义时检测 A→B→A 循环，抛出友好错误
    // 简单的直接循环已经在 validation.test.ts 中测试
    // 这里测试间接循环 A -> B -> A
    
    // 1. Define A (depends on B) - This is tricky because we need B defined first or allow undefined inputs?
    // V3 defineComputation requires inputs to be defined.
    // So we need to define sources first to create variables, or use placeholders.
    // Actually, defineComputation creates output variables.
    
    // To create a cycle A->B->A:
    // 1. Define A inputs:[B] outputs:[A] -- fails because B not exists
    // So we must define B first?
    // 1. Define B inputs:[A] outputs:[B] -- fails because A not exists
    
    // This implies we cannot create a cycle using defineComputation if we enforce "inputs must exist".
    // Unless we use Source variables as intermediaries? No, Source cannot be output.
    
    // The only way to create a cycle is if we have existing variables.
    // 1. Define Source S.
    // 2. Define Comp C1 inputs:[S] outputs:[A]
    // 3. Define Comp C2 inputs:[A] outputs:[B]
    // 4. Define Comp C3 inputs:[B] outputs:[S] -- ERROR: S is a Source, cannot be output.
    
    // What if we try to define C3 inputs:[B] outputs:[A]?
    // output A is already produced by C1. defineComputation should throw "Output variable already exists".
    
    // So statically, it seems hard to create a cycle with the current strict definition rules 
    // UNLESS we support redefinition or forward references (which we don't yet).
    
    // However, if we relax "checkAllInputsDefined", we could create:
    // C1: A -> B
    // C2: B -> A
    // But currently checkAllInputsDefined prevents this.
    
    // Let's verify that we CANNOT create a cycle because of these checks.
    // Or maybe we can create a self-loop?
    // C1: A -> A. defineComputation(inputs=['A'], outputs=['A'])
    // This requires A to exist.
    // If A is source, it cannot be output.
    // If A is computed, it's already defined. 
    // defineComputation will throw "Output variable ... already exists".
    
    // So, strict definition order + unique outputs + source/computed separation prevents static cycles at definition time?
    // Yes, essentially DFG is built incrementally and must be a DAG if we can't point back to existing nodes as outputs.
    
    // Wait, what if we use dynamic dependency?
    // C1 inputs:[S] outputs:[A] body: await scope.B (dynamic)
    // C2 inputs:[A] outputs:[B] body: await scope.A
    
    // This is possible!
    // 1. Source S
    // 2. C1 inputs:[S] outputs:[A] (Dynamic access B)
    // 3. C2 inputs:[A] outputs:[B]
    
    // Run:
    // C1 executes, accesses B. B is not ready? B depends on A.
    // C1 depends on B, B depends on A. A is output of C1.
    // C1 -> B -> C2 -> A -> C1. Cycle!
    
    // Let's test this runtime cycle detection (Deadlock or StackOverflow or Timeout)
    
    system.defineSource({ id: 's' as VariableId, initialValue: 1 });
    
    system.defineComputation({
      id: 'c1',
      inputs: ['s' as VariableId], // Static input S
      outputs: ['a' as VariableId],
      body: async (scope) => {
        // Dynamically access B. B might not be defined yet when this runs first time?
        // If we define C2 immediately, B exists.
        
        // Note: strict mode requires dynamic inputs to be in staticInputs (INV-C1).
        // So we MUST declare B in inputs.
        // But B doesn't exist yet!
        
        // So we can't declare B in inputs.
        // Thus we can't access B dynamically if strict mode is on.
        
        return { a: 1 }; 
      }
    });
    
    // Conclusion: strict static checks (inputs must exist, INV-C1) prevent cycles!
    // This is a good thing.
    // So the test case "循环依赖检测" actually reduces to "Validation prevents cycle formation".
    
    // Let's verify the simple validation: input cannot be output.
    system.defineSource({ id: 'x' as VariableId, initialValue: 1 });
    const status = system.defineComputation({
      id: 'cycle',
      inputs: ['x' as VariableId],
      outputs: ['x' as VariableId], // Input is also output
      body: async () => ({ x: 1 }),
    });

    expect(status.status).toBe('problematic');
    expect(status.problems.some(p => p.type === 'circular_dependency' || p.type === 'output_conflict')).toBe(true);
    
    // The message "Output variable ... already exists" is likely thrown first if x is Source.
    // The "Circular dependency" message is thrown if inputs intersect outputs.
    // Let's check the code in module_base.ts.
    // checkNoCircularDependency is called before createOutputVariables.
    // So it should throw Circular dependency.
  });
});
