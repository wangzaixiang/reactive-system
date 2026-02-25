import type { ComputationDefinition, VariableId } from "./types";
import { ReactiveModuleProblemManagement } from "./module_problem_management";
import { ProblemComputation, ProblemReason } from "./problem_types";
import { Variable } from "./variable";
import { Computation } from "./computation";

/**
 * ReactiveModuleRepairEngine - 自动修复与重试引擎
 *
 * 职责：
 * - 针对 problem 的定义，根据触发事件增量重评估并尝试恢复
 * - 修复类型：missing-input / duplicate-output / circular-dependency
 */
export abstract class ReactiveModuleRepairEngine extends ReactiveModuleProblemManagement {
  
  protected _tryRepairUndefinedInputs(changedVarId: VariableId): void {
      // Find candidates in problem_computations (Phase 6 optimization: use index)
      const candidates: string[] = [];
      for (const comp of this.problem_computations.values()) {
          if (comp.missingInputs?.has(changedVarId)) {
              candidates.push(comp.id);
          }
      }
      
      for (const compId of candidates) {
          const comp = this.problem_computations.get(compId);
          if (!comp) continue;

          // Update missing inputs
          comp.missingInputs?.delete(changedVarId);
          
          const missingInputs = this.getMissingInputsList(comp);

          // Check if can recover
          if (missingInputs.length === 0 && !this.hasOutputConflicts(comp)) {
              this.recoverComputation(comp);
          }
          else {
              if (missingInputs.length > 0) {
                  comp.missingInputs = new Set(missingInputs);
              }
              this.updateProblemReason(comp);
          }
      }
  }

  protected _tryRepairOutputConflicts(releasedOutputId: VariableId): void {
      const waiters = this.outputWaiters.get(releasedOutputId);
      if (!waiters || waiters.size === 0) return;
      
      const candidates = Array.from(waiters);
      
      for (const compId of candidates) {
          const comp = this.problem_computations.get(compId);
          if (!comp) {
              waiters.delete(compId); // Lazy cleanup
              continue;
          }
          
          if (this.canRecover(comp)) {
              this.recoverComputation(comp);
          } else {
              // If recovery failed (e.g. still conflicting with new owner), update reason
              if (comp.problemReason.type === 'duplicate-output') {
                  for (const outId of comp.definition.outputs) {
                      const existing = this.variables.get(outId) ?? this.problem_variables.get(outId);
                      if (existing && existing.producer && existing.producer.id !== comp.id) {
                           // Update conflict source
                           (comp.problemReason as any).conflictsWith = existing.producer.id;
                      }
                  }
              }
          }
      }
  }

  protected _tryRepairCircularDependencies(): void {
      // Any problem computation might be recoverable or need reason update when graph structure changes
      const candidates: string[] = Array.from(this.problem_computations.keys());
      
      for (const compId of candidates) {
          const comp = this.problem_computations.get(compId);
          if (!comp) continue;
          
          const recoverable = this.canRecover(comp);

          if (recoverable) {
              this.recoverComputation(comp);
          } else {
              // Even if not recoverable to Normal DAG, we might need to update the problem reason
              // (e.g. from circular-dependency to missing-input if cycle was broken)
              const cycle = this.detectCircularDependencyIfAdded(comp.definition);
              if (!cycle && comp.problemReason.type === 'circular-dependency') {
                  const missingInputs = this.getMissingInputsList(comp);
                  const newReason: ProblemReason = { type: 'missing-input', missingInputs };
                  comp.problemReason = newReason;
                  
                  // Sync with problemTracker
                  this.problemTracker.setProblems(comp.id, [this.convertReasonToProblem(comp.id, newReason)]);
                  
                  // Update fatal results for observers
                  for (const outVar of comp.outputs.values()) {
                      if (outVar.result.type === 'fatal') {
                          outVar.result.error.reason = 'missing-input';
                          outVar.result.error.details.missingInputs = missingInputs;
                          for (const obs of outVar.observers) {
                              try { obs(outVar.result); } catch(e) {}
                          }
                      }
                  }
              }
          }
      }
  }

  // Phase 3: recoverComputation
  private getMissingInputsList(comp: ProblemComputation): VariableId[] {
      const missing: VariableId[] = [];
      for (const input of comp.definition.inputs) {
          if (!this.variables.has(input)) {
              missing.push(input);
          }
      }
      return missing;
  }

  private hasOutputConflicts(comp: ProblemComputation): boolean {
      for (const outId of comp.definition.outputs) {
          if (this.variables.has(outId)) {
              this.isLogEnabled("debug") && this.log("debug", "hasOutputConflicts", `${comp.id} failed: output ${outId} already in variables (conflict)`, 0);
              return true;
          }
      }
      return false;
  }

  private canRecover(comp: ProblemComputation): boolean {
      return this.getMissingInputsList(comp).length === 0 && !this.hasOutputConflicts(comp);
  }
  
  private recoverComputation(comp: ProblemComputation): void {
      this.isLogEnabled("info") && this.log("info", "recoverComputation", `Recovering ${comp.id}`, 0);

      const outputsMap = new Map<VariableId, Variable>();
      const def = comp.definition;
      const initialCauseAt = this.computeInitialCauseAt(def);

      // 1. Prepare outputs (Move existing or Create new)
      for (const outId of def.outputs) {
          if (this.variables.has(outId)) {
               throw new Error(`Recovery failed: Output ${outId} conflict.`);
          }

          let variable = comp.outputs.get(outId);
          if (variable) {
              // Existing problem variable: Move it
              this.problem_variables.delete(outId);
              
              // Reset state
              variable.result = { type: 'uninitialized' };
              variable.value_at = 0;
              variable.cause_at = initialCauseAt;
              variable.dirty = true;
              variable.producer = null; 
          } else {
              // Missing variable (was conflicting): Create new
              variable = new Variable(outId, {
                  result: { type: 'uninitialized' },
                  value_at: 0,
                  cause_at: initialCauseAt,
                  dirty: true,
                  producer: null,
                  isRecursivelyObserved: false
              });
          }
          
          this.variables.set(outId, variable);
          outputsMap.set(outId, variable);
      }
      
      this.problem_computations.delete(comp.id);
      this.problemTracker.clearProblems(comp.id);
      
      // 2. Create Normal Computation
      const staticInputs = new Set(def.inputs);
      const { initialDirtyInputCount } = this.countInitialDirtyInputs(def);
      
      const newComputation = this.createComputationObject(
          def,
          staticInputs,
          outputsMap,
          initialDirtyInputCount,
          initialCauseAt
      );
      
      this._linkOutputsToProducer(outputsMap, newComputation, 0);
      this.establishInputDependencies(def, newComputation);
      
      // Restore observeCount for reused variables
      for (const variable of outputsMap.values()) {
          if (variable.observeCount > 0) {
              newComputation.observeCount += variable.observeCount;
              for (const input of newComputation.runtimeInputs) {
                  this._propagateObserveCountUpward(input, variable.observeCount, 0);
              }
          }
      }
      
      // 3. Trigger downstream recovery
      for (const out of def.outputs) {
          this._tryRepairUndefinedInputs(out);
      }
      
      // Also check if any circular dependencies can be broken now
      // (Simplified: trigger a re-check of all circular problems if any node recovered)
      this._tryRepairCircularDependencies();
  }
  
  protected suspendExistingComputationToPending(
    definition: ComputationDefinition,
    problems: any[]
  ): void {
      // Legacy stub
  }
}