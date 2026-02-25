import type { ComputationDefinition, VariableId, Observer } from "./types";
import type { Problem, RemovalStatus } from "./problem_tracking_types";
import {
    createInvalidOperationProblem,
    createNotFoundProblem,
} from "./problem_tracking_types";
import { Variable } from "./variable";
import { ReactiveModuleRepairEngine } from "./module_repair_engine";
import { Computation } from "./computation";

/**
 * ReactiveModuleLifecycleOps - 生命周期操作（重定义/删除/挂起迁移）
 *
 * 职责：
 * - redefine / remove 这类会主动改变图结构的操作
 * - 将受影响节点标记为 problem，并触发 repair engine
 */
export abstract class ReactiveModuleBase extends ReactiveModuleRepairEngine {
    
    // Stub for Phase 5: Redefine
    protected _redefineComputation(definition: ComputationDefinition, indent: number): void {
         const comp = this.getComputation(definition.id);
         if (comp.runningTask) (comp as any).abortTask?.("redefineComputation");

         // Unsubscribe inputs
         for (const inputVar of comp.runtimeInputs) {
            inputVar.dependents.delete(comp);
            if (comp.observeCount > 0) this._propagateObserveCountUpward(inputVar, -comp.observeCount, indent + 1);
         }
         comp.runtimeInputs.clear();

         this._fullRedefineLogic(comp, definition, indent);
    }
    
    private _fullRedefineLogic(comp: Computation, definition: ComputationDefinition, indent: number) {
        const oldOutputs = new Set<VariableId>(Array.from(comp.outputs.keys()));
        const newOutputs = new Set<VariableId>(definition.outputs);

        for (const outputId of oldOutputs) {
            if (newOutputs.has(outputId)) continue;
            
            // Output removed: Find dependents and mark as problem
            const v = this.variables.get(outputId);
            if (v) {
                const dependents = Array.from(v.dependents);
                
                this.variables.delete(outputId);
                comp.outputs.delete(outputId);
                this._tryRepairOutputConflicts(outputId);
                
                for (const dep of dependents) {
                    if (dep.id !== comp.id && this.computations.has(dep.id)) {
                        this.markComputationAsProblem(dep, {
                            type: 'missing-input',
                            missingInputs: [outputId]
                        });
                    }
                }
            }
        }

        for (const outputId of newOutputs) {
            if (oldOutputs.has(outputId)) continue;
            if (this.variables.has(outputId)) {
                // If conflict happens here, it means we failed to detect it earlier?
                // `evaluateDefinitionProblems` should have caught it.
                // But if we are in _redefineComputation, we assume it's safe (Normal->Normal).
                // If conflict, we should have used `replaceExistingComputation`.
                throw new Error(`Output variable ${outputId} already exists.`);
            }
            const outputVariable = new Variable(outputId, {
                result: { type: "uninitialized" },
                value_at: 0,
                cause_at: comp.cause_at,
                dirty: true,
                producer: comp,
            });
            this.variables.set(outputId, outputVariable);
            comp.outputs.set(outputId, outputVariable);
        }

        comp.staticInputs = new Set<VariableId>(definition.inputs);
        for (const inputId of comp.staticInputs) {
            const variable = this.variables.get(inputId);
            if (!variable) {
                 throw new Error(`Internal error: input ${inputId} should exist before redefine`);
            }
            comp.runtimeInputs.add(variable);
            variable.dependents.add(comp);
            if (comp.observeCount > 0) {
                this._propagateObserveCountUpward(variable, comp.observeCount, indent + 1);
            }
        }

        comp.dirtyInputCount = this.calculateConservativeDirtyInputCountLocal(comp);
        const t = this.nextLogicalClock();
        comp.body = definition.body;
        comp.cause_at = t;
        comp.input_version = -1;
        comp.dirty = true;
        for (const outputVar of comp.outputs.values()) {
            outputVar.cause_at = t;
            outputVar.dirty = true;
            this._markDirty(outputVar, t, true, indent + 1);
        }

        this._tryRepairCircularDependencies();
    }
    
    protected replaceExistingComputation(definition: ComputationDefinition): void {
        // 1. Capture Observers
        const oldObservers = new Map<VariableId, Set<Observer>>();
        
        const existingComp = this.computations.get(definition.id) ?? this.problem_computations.get(definition.id);
        if (existingComp) {
            for (const [outId, variable] of existingComp.outputs) {
                if (variable.observers.size > 0) {
                    oldObservers.set(outId, new Set(variable.observers));
                }
            }
        }

        this.removeComputation(definition.id);
        this._defineComputation(definition, { allowRedefinition: true });

        // 2. Restore Observers
        if (oldObservers.size > 0) {
            const newComp = this.computations.get(definition.id) ?? this.problem_computations.get(definition.id);
            if (newComp) {
                for (const [outId, observers] of oldObservers) {
                    const newVar = newComp.outputs.get(outId);
                    if (newVar) {
                        for (const obs of observers) {
                            newVar.observers.add(obs);
                        }
                         
                        // Restore observeCount propagation
                        if (observers.size > 0) {
                             this._propagateObserveCountUpward(newVar, observers.size, 0);
                        }

                        // Notify new state immediately
                        for (const obs of observers) {
                            try { obs(newVar.result); } catch(e) {}
                        }
                    }
                }
            }
        }
    }

    private calculateConservativeDirtyInputCountLocal(comp: any): number {
        let count = 0;
        for (const input of comp.runtimeInputs as Set<Variable>) {
            if (input.producer !== null && input.dirty) count++;
        }
        return count;
    }

    // -------------------------------------------------------------------------
    // Lifecycle Ops (Dual-DAG Aware)
    // -------------------------------------------------------------------------

    public removeSource(id: VariableId): RemovalStatus {
        const variable = this.variables.get(id);
        if (!variable) {
            return { id, success: false, affectedComputations: [], problems: [createNotFoundProblem(id, "source")] };
        }
        if (variable.producer !== null) {
            return {
                id,
                success: false,
                affectedComputations: [],
                problems: [createInvalidOperationProblem(id, "removeSource", `Variable '${id}' is not a source variable.`)],
            };
        }

        const affected = Array.from(variable.dependents);
        this.variables.delete(id);

        // Recursive Marking (Task 1.4 + 2.1)
        for (const comp of affected) {
            if (this.computations.has(comp.id)) {
                this.markComputationAsProblem(comp, { 
                    type: 'missing-input', 
                    missingInputs: [id] 
                });
            } else if (this.problem_computations.has(comp.id)) {
                const probComp = this.problem_computations.get(comp.id)!;
                if (probComp.problemReason.type === 'missing-input') {
                    probComp.missingInputs?.add(id);
                    this.updateProblemReason(probComp);
                }
            }
        }

        this._tryRepairOutputConflicts(id);
        this._tryRepairCircularDependencies();

        return { id, success: true, affectedComputations: affected.map(c => c.id), problems: [] };
    }

    public removeComputation(id: string, options?: { cascadeDelete?: boolean }): RemovalStatus {
        if (this.problem_computations.has(id)) {
            // Remove problem computation
            const comp = this.problem_computations.get(id)!;
            this.problem_computations.delete(id);
            this.problemTracker.clearProblems(id);
            for (const out of comp.outputs.keys()) {
                this.variables.delete(out); // Wait, problem variables are in problem_variables, not variables?
                // outputs keys are output IDs.
                // In _createProblemComputation, we put them in problem_variables.
                this.problem_variables.delete(out);
                
                // Trigger repairs?
                this._tryRepairOutputConflicts(out);
            }
            this._tryRepairCircularDependencies();
            return { id, success: true, affectedComputations: [], problems: [] };
        }

        const comp = this.computations.get(id);
        if (!comp) {
            if (this.pendingComputations.has(id)) {
                this.clearPendingComputation(id); // Legacy cleanup
                return { id, success: true, affectedComputations: [], problems: [] };
            }
            return { id, success: false, affectedComputations: [], problems: [createNotFoundProblem(id, "computation")] };
        }

        if (comp.runningTask) (comp as any).abortTask?.("removeComputation");

        const outputs = Array.from(comp.outputs.keys());
        
        // Find dependents before deleting variables
        const affectedDependents = new Set<Computation>();
        for (const outputId of outputs) {
            const v = this.variables.get(outputId);
            if (v) {
                for (const dep of v.dependents) affectedDependents.add(dep);
            }
        }

        // Cleanup
        for (const outputId of outputs) {
            this.variables.delete(outputId);
            this._tryRepairOutputConflicts(outputId);
        }

        for (const inputVar of comp.runtimeInputs) {
            inputVar.dependents.delete(comp);
            if (comp.observeCount > 0) this._propagateObserveCountUpward(inputVar, -comp.observeCount, 0);
        }

        this.computations.delete(id);
        this.problemTracker.clearProblems(id);

        // Recursive Marking
        for (const dep of affectedDependents) {
            const missing = Array.from(dep.runtimeInputs).filter(v => outputs.includes(v.id)).map(v => v.id);
            const missingIds = missing.length > 0 ? missing : outputs;

            if (this.computations.has(dep.id)) {
                this.markComputationAsProblem(dep, {
                    type: 'missing-input',
                    missingInputs: missingIds
                });
            } else if (this.problem_computations.has(dep.id)) {
                const probComp = this.problem_computations.get(dep.id)!;
                if (probComp.problemReason.type === 'missing-input') {
                    missingIds.forEach(id => probComp.missingInputs?.add(id));
                    this.updateProblemReason(probComp);
                }
            }
        }
        
        // TODO: Handle cascadeDelete option (ignore for now or map to recursive marking?)
        // Contract doesn't mention cascadeDelete for removeComputation.
        // It says recursive marking is automatic.

        this._tryRepairCircularDependencies();

        return { id, success: true, affectedComputations: Array.from(affectedDependents).map(c=>c.id), problems: [] };
    }

    // Legacy support
    protected suspendExistingComputationToPending(definition: ComputationDefinition, problems: Problem[]): void {
        // ... (Legacy code, maybe keep or stub?)
        // Ideally we shouldn't use it anymore.
    }
}