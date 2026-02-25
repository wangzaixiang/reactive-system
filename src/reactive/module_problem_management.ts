import type {
  ComputationDefinition,
  ReactiveModuleOptions,
  SourceDefinition,
  VariableId,
} from "./types";
import type {
  ComputationStatus,
  Problem,
  ProblemSeverity,
  ProblemType,
  SourceStatus,
} from "./problem_tracking_types";
import {
  createCircularDependencyProblem,
  createDuplicateDefinitionProblem,
  createInvalidOperationProblem,
  createOutputConflictProblem,
  createUndefinedInputProblem,
} from "./problem_tracking_types";
import { ProblemTracker } from "./problem_tracker";
import { ReactiveModuleDefinition } from "./module_definition";
import { ProblemDiagnostic, ProblemTrace, GraphHealth, ProblemReason, ProblemComputation } from "./problem_types";
import { Computation } from "./computation";
import { Variable } from "./variable";

/**
 * ReactiveModuleProblemManagement - Notebook/编辑器策略层的“数据管理层”
 *
 * 职责：
 * - 问题存储与查询（ProblemTracker）
 * - 对外容错 defineSource/defineComputation
 * - 核心问题标记逻辑 (markComputationAsProblem)
 */
export abstract class ReactiveModuleProblemManagement extends ReactiveModuleDefinition {
  protected pendingComputations: Map<string, ComputationDefinition> = new Map();
  // private pendingSequence: number = 0;
  private pendingUpdatedAt: Map<string, number> = new Map();

  protected constructor(options: ReactiveModuleOptions = {}) {
    super(options);
  }

  // -------------------------------------------------------------------------
  // New Diagnostic APIs (Problem Recovery Redesign)
  // -------------------------------------------------------------------------

  public getProblemComputations(): ProblemDiagnostic[] {
      return Array.from(this.problem_computations.values()).map(comp => ({
          computationId: comp.id,
          reason: comp.problemReason,
          affectedOutputs: Array.from(comp.outputs.keys()),
          downstreamProblems: [], 
          canRecover: false, 
      }));
  }

  public getProblemVariables(): VariableId[] {
      return Array.from(this.problem_variables.keys());
  }
  
  public traceProblemRoot(id: string): ProblemTrace {
       if (!this.problem_computations.has(id)) {
           throw new Error(`Problem computation ${id} not found`);
       }
       
       const comp = this.problem_computations.get(id)!;
       const trace: ProblemTrace = {
           computationId: id,
           reason: comp.problemReason,
           upstreamProblems: []
       };
       
       // BFS/DFS to find root cause
       // Simplified: Find first upstream problem
       if (comp.problemReason.type === 'missing-input') {
           const missing = comp.missingInputs;
           if (missing) {
               for (const input of missing) {
                   // Check if input is a problem variable
                   if (this.problem_variables.has(input)) {
                       const producer = this.problem_variables.get(input)!.producer as ProblemComputation;
                       if (producer) {
                           trace.upstreamProblems!.push({
                               computationId: producer.id,
                               outputVariable: input,
                               reason: producer.problemReason
                           });
                           
                           // Recursive trace? Contract returns ONE rootCause.
                           // "upstreamProblems?: Array<...>" - intermediate chain?
                           // "rootCause?: { ... }" - final root.
                           
                           // If producer is root cause (e.g. missing external input)
                           // We need to trace deeper.
                           const upTrace = this.traceProblemRoot(producer.id);
                           if (upTrace.rootCause) {
                               trace.rootCause = upTrace.rootCause;
                           } else {
                               // Producer is root
                               trace.rootCause = {
                                   computationId: producer.id,
                                   reason: producer.problemReason
                               };
                           }
                           
                           // Merge upstream problems?
                           // For now, just take the first path found
                           if (upTrace.upstreamProblems) {
                               trace.upstreamProblems!.push(...upTrace.upstreamProblems);
                           }
                           return trace; 
                       }
                   }
               }
           }
       }
       
       // If no upstream problem found, I am root
       trace.rootCause = {
           computationId: id,
           reason: comp.problemReason
       };
       
       return trace;
  }
  
  public getGraphHealth(): GraphHealth {
      const rootProblems: GraphHealth['rootProblems'] = [];
      
      // Identify root problems
      for (const comp of this.problem_computations.values()) {
          // A root problem is one that doesn't depend on other problem variables
          let dependsOnProblem = false;
          
          if (comp.problemReason.type === 'missing-input' && comp.missingInputs) {
              for (const input of comp.missingInputs) {
                  if (this.problem_variables.has(input)) {
                      dependsOnProblem = true;
                      break;
                  }
              }
          }
          // Circular dependency is a root problem (structural)
          // Duplicate output is a root problem (conflict)
          // Invalid definition is a root problem
          
          if (!dependsOnProblem) {
              // Calculate impact (downstream count)
              // BFS downstream in problem graph
              let affectedCount = 0;
              const queue = [comp.id];
              const visited = new Set<string>([comp.id]);
              
              // This is expensive O(N^2) without index. 
              // Phase 6 optimization suggests index.
              // For now, simple iteration.
              
              // We need to find who depends on my outputs (which are problem variables)
              // My outputs are in problem_variables.
              // Their dependents are tracked in `variable.dependents`.
              // So we can use that!
              
              while (queue.length > 0) {
                  const currId = queue.shift()!;
                  const currComp = this.problem_computations.get(currId)!;
                  
                  for (const outVar of currComp.outputs.values()) {
                      for (const dep of outVar.dependents) {
                          if (this.problem_computations.has(dep.id) && !visited.has(dep.id)) {
                              visited.add(dep.id);
                              queue.push(dep.id);
                              affectedCount++;
                          }
                      }
                  }
              }
              
              rootProblems.push({
                  computationId: comp.id,
                  reason: comp.problemReason,
                  affectedCount,
                  canRecover: false // Stub
              });
          }
      }
      
      const total = this.computations.size + this.problem_computations.size;
      const score = total === 0 ? 100 : (this.computations.size / total) * 100;

      return { 
          totalComputations: total, 
          normalComputations: this.computations.size, 
          problemComputations: this.problem_computations.size, 
          totalVariables: this.variables.size + this.problem_variables.size, 
          normalVariables: this.variables.size, 
          problemVariables: this.problem_variables.size, 
          rootProblems, 
          healthScore: score
      };
  }

  // -------------------------------------------------------------------------
  // Public define APIs (fault-tolerant)
  // -------------------------------------------------------------------------

  public defineSource(
    definition: SourceDefinition,
    options?: { allowRedefinition?: boolean }
  ): SourceStatus {
    const existing = this.variables.get(definition.id);

    if (existing) {
      if (options?.allowRedefinition) {
        if (existing.producer !== null) {
          const problem = createInvalidOperationProblem(
            definition.id,
            "defineSource(allowRedefinition)",
            `Cannot redefine computed variable '${definition.id}' as source.`
          );
          return { id: definition.id, status: "problematic", problems: [problem] };
        }

        if (definition.initialValue !== undefined) {
          this._updateSource(definition.id, definition.initialValue, 0);
        }

        this._tryRepairUndefinedInputs(definition.id);
        return { id: definition.id, status: "healthy", problems: [] };
      }

      const existingEntityType = existing.producer ? "computation" : "source";
      const problem = createDuplicateDefinitionProblem(definition.id, existingEntityType, false);
      return { id: definition.id, status: "problematic", problems: [problem] };
    }

    this._defineSource(definition, 0);
    this._tryRepairUndefinedInputs(definition.id);
    return { id: definition.id, status: "healthy", problems: [] };
  }

  public defineComputation(
    definition: ComputationDefinition,
    options?: { allowRedefinition?: boolean }
  ): ComputationStatus {
    if (this.pendingComputations.has(definition.id)) {
      this.clearPendingComputation(definition.id);
    }

    const existingComp = this.computations.get(definition.id) ?? this.problem_computations.get(definition.id);
    
    if (existingComp) {
      if (options?.allowRedefinition)  return this.redefineComputation(definition);
      else {
        const problem = createDuplicateDefinitionProblem(definition.id, "computation", false);
        return {id: definition.id, status: "problematic", problems: [problem]};
      }
    }
    else  return this.defineNewComputation(definition);

  }

  private defineNewComputation(definition: ComputationDefinition) : ComputationStatus {
    this._defineComputation(definition, { allowRedefinition: false });

    if (this.problem_computations.has(definition.id)) {
        const comp = this.problem_computations.get(definition.id)!;
        const problems = [ this.convertReasonToProblem(definition.id, comp.problemReason) ];
        
        // Sync with problemTracker for diagnostic APIs
        this.problemTracker.setProblems(definition.id, problems);

        // Even if problematic, we should try to repair anyone waiting for our outputs
        for (const out of definition.outputs) {
            this._tryRepairUndefinedInputs(out);
        }

        // Phase 5: Mark Cycle
        if (comp.problemReason.type === 'circular-dependency') {
            const cycle = comp.problemReason.cyclePath;
            if (cycle) {
                for (const nodeId of cycle) {
                    if (nodeId === definition.id) continue;
                    
                    const node = this.computations.get(nodeId);
                    if (node) {
                        this.markComputationAsProblem(node, {
                            type: 'circular-dependency',
                            cyclePath: cycle
                        });
                    } else {
                        // Check problem computations
                        const probNode = this.problem_computations.get(nodeId);
                        if (probNode) {
                            // Update reason
                            probNode.problemReason = { type: 'circular-dependency', cyclePath: cycle };
                            // Notify observers
                            for (const output of probNode.outputs.values()) {
                                if (output.result.type === 'fatal') {
                                    output.result.error.reason = 'circular-dependency';
                                    output.result.error.details.cyclePath = cycle;
                                    for (const obs of output.observers) {
                                        try { obs(output.result); } catch(e) {}
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        
        return { id: definition.id, status: "problematic", problems };
    }

    // Healthy
    for (const out of definition.outputs) {
      this._tryRepairUndefinedInputs(out);
    }
    
    return {id: definition.id, status: "healthy", problems: []};
  }

  private redefineComputation(definition: ComputationDefinition): ComputationStatus {
      const problems = this.evaluateDefinitionProblems(definition, definition.id);
      
      // If there are problems, or if we are currently a Problem computation
      // We use the full replace cycle (Remove + Define)
      if (problems.length > 0 || this.problem_computations.has(definition.id)) {
          this.replaceExistingComputation(definition);
          
          // After definition, trigger repairs for anyone waiting for our outputs
          for (const out of definition.outputs) {
              this._tryRepairUndefinedInputs(out);
          }
          this._tryRepairCircularDependencies();

          if (problems.length > 0) {
               return {id: definition.id, status: "problematic", problems};
          } else {
               return { id: definition.id, status: "healthy", problems: [] };
          }
      }

      // Normal -> Normal (Optimized path)
      this._redefineComputation(definition, 0);
      return { id: definition.id, status: "healthy", problems: [] };
  }

  // -------------------------------------------------------------------------
  // Helper: Mark as Problem (Task 2.1)
  // -------------------------------------------------------------------------
    
  protected markComputationAsProblem(comp: Computation, reason: ProblemReason): void {
      // 1. Remove from computations
      this.computations.delete(comp.id);
      
      // 2. Unsubscribe inputs
      for (const inputVar of comp.runtimeInputs) {
          inputVar.dependents.delete(comp);
          if (comp.observeCount > 0) {
               this._propagateObserveCountUpward(inputVar, -comp.observeCount, 0);
          }
      }
      comp.runtimeInputs.clear();
      
      // 3. Move outputs to problem_variables
      const outputsMap = new Map<VariableId, Variable>();
      for (const [outputId, variable] of comp.outputs) {
           this.variables.delete(outputId);
           
           variable.result = { 
               type: 'fatal', 
               error: { 
                   kind: 'structural', 
                   reason: reason.type as any, 
                   details: { 
                       computationId: comp.id,
                       missingInputs: reason.type === 'missing-input' ? reason.missingInputs : undefined,
                       cyclePath: reason.type === 'circular-dependency' ? reason.cyclePath : undefined,
                       conflictsWith: reason.type === 'duplicate-output' ? reason.conflictsWith : undefined,
                   } as any 
               } 
           };
           
           this.problem_variables.set(outputId, variable);
           outputsMap.set(outputId, variable);
           
           for (const observer of variable.observers) {
               try { observer(variable.result); } catch(e) {}
           }
      }
      
      // 4. Create ProblemComputation
      const problemComp = comp as unknown as ProblemComputation;
      problemComp.problemReason = reason;
      problemComp.missingInputs = new Set(); 
      if (reason.type === 'missing-input') {
          reason.missingInputs.forEach((id: VariableId) => problemComp.missingInputs!.add(id));
      }
      
      problemComp.definition = {
          id: comp.id,
          inputs: Array.from(comp.staticInputs),
          outputs: Array.from(outputsMap.keys()),
          body: comp.body
      };
      
      this.problem_computations.set(comp.id, problemComp);
      
      // Sync with problemTracker
      this.problemTracker.setProblems(comp.id, [this.convertReasonToProblem(comp.id, reason)]);

      // 5. Recursive marking (Phase 2)
      for (const variable of outputsMap.values()) {
          const dependents = Array.from(variable.dependents);
          for (const dep of dependents) {
              if (this.computations.has(dep.id)) {
                   this.markComputationAsProblem(dep, { 
                       type: 'missing-input', 
                       missingInputs: [variable.id] 
                   });
              } else if (this.problem_computations.has(dep.id)) {
                  const probComp = this.problem_computations.get(dep.id)!;
                  if (probComp.problemReason.type === 'missing-input') {
                      probComp.missingInputs?.add(variable.id);
                      this.updateProblemReason(probComp);
                  }
              }
          }
      }
  }

  protected updateProblemReason(comp: ProblemComputation): void {
      if (comp.problemReason.type === 'missing-input') {
           const missing = Array.from(comp.missingInputs || []);
           if (missing.length > 0) {
               (comp.problemReason as any).missingInputs = missing;
           }
      }
  }

  private evaluateDefinitionProblems(
    definition: ComputationDefinition,
    allowExistingProducerId?: string
  ): Problem[] {
    const problems: Problem[] = [];

    const undefinedInputs = definition.inputs.filter((id) => !this.variables.has(id));
    if (undefinedInputs.length > 0) {
      problems.push(createUndefinedInputProblem(definition.id, undefinedInputs));
    }

    const conflictInfo = this.getOutputConflictInfo(definition, allowExistingProducerId);
    if (conflictInfo) {
      problems.push(
        createOutputConflictProblem(
          definition.id,
          conflictInfo.conflictingOutput,
          conflictInfo.existingProducer
        )
      );
    }

    if (!conflictInfo) {
      const cycle = this.detectCircularDependencyIfAdded(definition);
      if (cycle) {
        problems.push(createCircularDependencyProblem(definition.id, cycle));
      }
    }

    return problems;
  }

  // -------------------------------------------------------------------------
  // Query APIs
  // -------------------------------------------------------------------------

  public getProblems(filter?: {
    type?: ProblemType;
    severity?: ProblemSeverity;
    entityId?: string;
  }): Problem[] {
    return this.problemTracker.getProblems(filter);
  }

  public getSourceStatus(id: VariableId): SourceStatus {
    const variable = this.variables.get(id);
    if (!variable) {
      throw new Error(`Source variable ${id} not found.`);
    }

    if (variable.producer !== null) {
      throw new Error(`Variable ${id} is not a source variable.`);
    }

    const problems = this.problemTracker.getProblemsOf(id);
    return { id, status: problems.length === 0 ? "healthy" : "problematic", problems };
  }

  public getComputationStatus(id: string): ComputationStatus {
    if (this.pendingComputations.has(id)) {
      const problems = this.problemTracker.getProblemsOf(id);
      return { id, status: "problematic", problems };
    }

    if (this.problem_computations.has(id)) {
        const comp = this.problem_computations.get(id)!;
        const problems = [ this.convertReasonToProblem(id, comp.problemReason) ];
        return { id, status: "problematic", problems };
    }

    if (!this.computations.has(id)) {
      throw new Error(`Computation ${id} not found.`);
    }

    const problems = this.problemTracker.getProblemsOf(id);
    return { id, status: problems.length === 0 ? "healthy" : "problematic", problems };
  }

  // -------------------------------------------------------------------------
  // Legacy Pending Management
  // -------------------------------------------------------------------------
  
  protected clearPendingComputation(id: string): void {
    this.pendingComputations.delete(id);
    this.pendingUpdatedAt.delete(id);
    this.problemTracker.clearProblems(id);
  }

  // -------------------------------------------------------------------------
  // Hooks implemented by higher layers
  // -------------------------------------------------------------------------

  protected abstract _tryRepairUndefinedInputs(changedVarId: VariableId): void;
  protected abstract _tryRepairCircularDependencies(): void;
  protected abstract _redefineComputation(definition: ComputationDefinition, indent: number): void;
  protected abstract replaceExistingComputation(definition: ComputationDefinition): void;
  protected abstract suspendExistingComputationToPending(
    definition: ComputationDefinition,
    problems: Problem[]
  ): void;
}
