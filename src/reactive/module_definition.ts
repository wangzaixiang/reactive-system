import type {ComputationDefinition, ReactiveModuleOptions, SourceDefinition, VariableId, StructuralError, StructuralErrorReason} from "./types";
import type { ComputationStatus, Problem } from "./problem_tracking_types";
import {
    createCircularDependencyProblem,
    createInvalidOperationProblem,
    createOutputConflictProblem,
    createUndefinedInputProblem,
} from "./problem_tracking_types";
import { Variable } from "./variable";
import { Computation } from "./computation";
import { ProblemComputation, ProblemReason } from "./problem_types";
import { CircularDependencyError, NotImplementedError } from "./errors";
import { ReactiveModuleCore } from "./module_core";
import { buildDependencyGraph, detectCycleFrom, type ComputationShape } from "./dependency_graph";

/**
 * ReactiveModuleDefinition - 纯“建图/定义原语”
 *
 * 职责：
 * - 创建 Source Variable / Computation / Output Variables
 * - 建立 inputs/outputs 依赖关系
 * - 提供循环检测/输出冲突检测的“纯信息”方法（不产生 Problem 对象）
 *
 * 非职责：
 * - 不处理 pending/problem/repair/redefine/remove 的策略
 */
export abstract class ReactiveModuleDefinition extends ReactiveModuleCore {

  protected abstract _redefineComputation(definition: ComputationDefinition, indent: number): void;
  protected abstract markComputationAsProblem(comp: Computation, reason: ProblemReason): void;

  protected _defineSource(definition: SourceDefinition, indent: number): void {
    this.checkSourceNotExists(definition.id);
    this.nextLogicalClock();
    this._createSourceVariable(definition.id, indent);
    this._initializeSourceValue(definition, indent);
  }

  protected convertReasonToProblem(id: string, reason: ProblemReason): Problem {
      switch(reason.type) {
          case 'missing-input':
              return createUndefinedInputProblem(id, reason.missingInputs);
          case 'circular-dependency':
              return createCircularDependencyProblem(id, reason.cyclePath);
          case 'duplicate-output':
              return createOutputConflictProblem(id, reason.conflictsWith as any, 'unknown'); 
          case 'invalid-definition':
              return createInvalidOperationProblem(id, 'definition', reason.error);
          default:
              return createInvalidOperationProblem(id, 'definition', 'Unknown error');
      }
  }

  private checkSourceNotExists(id: VariableId): void {
    if (this.variables.has(id)) {
      throw new NotImplementedError(
        `Source variable ${id} already defined. Redefining is not yet supported.`
      );
    }
  }

  private _createSourceVariable(id: VariableId, indent: number): Variable {
    this.isLogEnabled("trace") && this.log("trace", "defineSource", `${id}`, indent);

    const newVariable = new Variable(id, {
      result: { type: "uninitialized" },
      value_at: 0,
      cause_at: 0,
      dirty: false,
      producer: null,
      isRecursivelyObserved: false,
    });
    this.variables.set(id, newVariable);
    return newVariable;
  }

  private _initializeSourceValue(definition: SourceDefinition, indent: number): void {
    if (definition.initialValue !== undefined) {
      this._updateSource(definition.id, definition.initialValue, indent);
    }
  }

  /**
   * 核心定义原语：创建一个新的 Computation 及其输出变量，并建立初始依赖关系
   * 
   * V2 Redesign: 支持 Problem Detection
   */
  protected _defineComputation(definition: ComputationDefinition, options: { allowRedefinition?: boolean } = {}): ComputationStatus {
      this.isLogEnabled('debug') && this.log('debug', 'defineComputation', definition.id);
      
      // ... 检查重复定义 ...
      if (this.computations.has(definition.id) || this.problem_computations.has(definition.id)) {
          if (!options.allowRedefinition) {
              throw new Error(`Computation ${definition.id} already defined.`);
          }
          this._redefineComputation(definition, 0);
          return { id: definition.id, status: 'healthy', problems: [] }; // Assume success for now, or let redefine handle it
      }

      // ... 检查问题 ...
      const missingInputs = this.getMissingInputs(definition);
      const problemInputs = this.getProblemInputs(definition);
      const conflictInfo = this.getOutputConflictInfo(definition);
      const cyclePath = this.detectCircularDependencyIfAdded(definition);

      if (missingInputs.size > 0 || problemInputs.size > 0 || conflictInfo !== null || cyclePath !== null) {
          const reason: ProblemReason = cyclePath !== null ? { type: 'circular-dependency', cyclePath } 
                                     : conflictInfo !== null ? { type: 'duplicate-output', conflictsWith: conflictInfo.existingProducer }
                                     : { type: 'missing-input', missingInputs: [...Array.from(missingInputs), ...Array.from(problemInputs)] };
          
          this.isLogEnabled('debug') && this.log('debug', 'defineComputation', `${definition.id} is problematic: ${JSON.stringify(reason)}`);
          this._createProblemComputation(definition, reason, new Set([...Array.from(missingInputs), ...Array.from(problemInputs)]), 0);
          return { 
              id: definition.id, 
              status: 'problematic', 
              problems: [this.convertReasonToProblem(definition.id, reason)] 
          };
      }

      this.isLogEnabled('debug') && this.log('debug', 'defineComputation', `${definition.id} is healthy, outputs: ${definition.outputs.join(',')}`);
      
      const initialCauseAt = this.computeInitialCauseAt(definition);
      const { initialDirtyInputCount } = this.countInitialDirtyInputs(definition);

      // ... 正常流程 ...
      const computation = new Computation(
          definition.id,
          new Set(definition.inputs),
          new Map(), // Outputs filled below
          definition.body,
          {
              dirty: true,
              cause_at: initialCauseAt,
              dirtyInputCount: initialDirtyInputCount,
              input_version: 0
          }
      );
      (computation as any).scheduler = this;

      this.computations.set(definition.id, computation);
      
      for (const outputId of definition.outputs) {
          const variable = new Variable(outputId, {
              producer: computation,
              dirty: true,
              cause_at: initialCauseAt,
              result: { type: 'uninitialized' }
          });
          this.variables.set(outputId, variable);
          computation.outputs.set(outputId, variable);
          this.isLogEnabled('debug') && this.log('debug', 'defineComputation', `Registered variable: ${outputId}`);
      }

      this.establishDependencies(definition, computation);
      this.problemTracker.clearProblems(definition.id);

      return { id: definition.id, status: 'healthy', problems: [] };
  }

  protected getMissingInputs(definition: ComputationDefinition): Set<VariableId> {
      const missing = new Set<VariableId>();
      for (const inputId of definition.inputs) {
          if (!this.variables.has(inputId) && !this.problem_variables.has(inputId)) {
              missing.add(inputId);
          }
      }
      return missing;
  }

  protected getProblemInputs(definition: ComputationDefinition): Set<VariableId> {
      const problemInputs = new Set<VariableId>();
      for (const inputId of definition.inputs) {
          if (this.problem_variables.has(inputId)) {
              problemInputs.add(inputId);
          }
      }
      return problemInputs;
  }

  protected getOutputConflicts(definition: ComputationDefinition): Set<VariableId> {
      const conflicts = new Set<VariableId>();
      for (const outputId of definition.outputs) {
          if (this.variables.has(outputId) || this.problem_variables.has(outputId)) {
              conflicts.add(outputId);
          }
      }
      return conflicts;
  }

  protected checkIsCircular(definition: ComputationDefinition): boolean {
      return this.detectCircularDependencyIfAdded(definition) !== null;
  }

  protected establishDependencies(definition: ComputationDefinition, computation: Computation): void {
      for (const inputId of definition.inputs) {
          const variable = this.variables.get(inputId) ?? this.problem_variables.get(inputId);
          if (variable) {
              variable.dependents.add(computation);
              computation.runtimeInputs.add(variable);
          }
      }
  }

  private _createProblemComputation(
    definition: ComputationDefinition, 
    reason: ProblemReason, 
    missingInputs: Set<VariableId>,
    indent: number
  ): void {
      this.isLogEnabled("info") && this.log("info", "defineComputation", `Creating PROBLEM computation ${definition.id}: ${reason.type}`, indent);

      // Create outputs in problem_variables (if not conflicting)
      const outputsMap = new Map<VariableId, Variable>();
      
      for (const outputId of definition.outputs) {
          // First-win: if conflict, don't create
          if (this.variables.has(outputId) || this.problem_variables.has(outputId)) {
              continue;
          }

          const variable = new Variable(outputId, {
            result: { 
                type: 'fatal', 
                error: { 
                    kind: 'structural', 
                    reason: reason.type as StructuralErrorReason,
                    details: { 
                         computationId: definition.id,
                         missingInputs: reason.type === 'missing-input' ? reason.missingInputs : undefined,
                         cyclePath: reason.type === 'circular-dependency' ? reason.cyclePath : undefined,
                         conflictsWith: reason.type === 'duplicate-output' ? reason.conflictsWith : undefined,
                         definitionError: reason.type === 'invalid-definition' ? reason.error : undefined
                    }
                } 
            },
            value_at: 0,
            cause_at: 0,
            dirty: false,
            producer: null, 
            isRecursivelyObserved: false
          });
          
          this.problem_variables.set(outputId, variable);
          outputsMap.set(outputId, variable);
      }

      // Create ProblemComputation
      // We assume Computation class can be used as base
      const problemComp = new Computation(
        definition.id,
        new Set(definition.inputs),
        outputsMap,
        definition.body
      ) as unknown as ProblemComputation;
      
      problemComp.problemReason = reason;
      problemComp.missingInputs = missingInputs;
      problemComp.definition = definition;
      
      // Link producer
      outputsMap.forEach(v => v.producer = problemComp);
      
      this.problem_computations.set(definition.id, problemComp);

      // Establish dependencies for existing inputs (Normal or Problem)
      // This ensures graph traversal (getGraphHealth) and recursive updates work
      for (const inputId of definition.inputs) {
          const inputVar = this.variables.get(inputId) ?? this.problem_variables.get(inputId);
          if (inputVar) {
              inputVar.dependents.add(problemComp as unknown as Computation);
          }
      }

      if (reason.type === 'duplicate-output') {
          for (const outputId of definition.outputs) {
              const existing = this.variables.get(outputId) ?? this.problem_variables.get(outputId);
              if (existing) {
                  let set = this.outputWaiters.get(outputId);
                  if (!set) {
                      set = new Set();
                      this.outputWaiters.set(outputId, set);
                  }
                  set.add(definition.id);
              }
          }
      }

      // Recursive Marking
      for (const variable of outputsMap.values()) {
          const dependents = Array.from(variable.dependents);
          for (const dep of dependents) {
              if (this.computations.has(dep.id)) {
                   this.markComputationAsProblem(dep, { 
                       type: 'missing-input', 
                       missingInputs: [variable.id] 
                   });
              }
          }
      }
  }

  private _createNormalComputation(definition: ComputationDefinition, indent: number): void {
    this.nextLogicalClock();
    const initialCauseAt = this.computeInitialCauseAt(definition);
    const staticInputs = new Set<VariableId>(definition.inputs);
    
    // Create outputs in variables
    const outputsMap = this._createOutputVariables(definition, initialCauseAt, indent + 1);
    
    const { initialDirtyInputCount, allInputsClean } = this.countInitialDirtyInputs(definition);

    const newComputation = this.createComputationObject(
      definition,
      staticInputs,
      outputsMap,
      initialDirtyInputCount,
      initialCauseAt
    );

    this._linkOutputsToProducer(outputsMap, newComputation, indent + 1);
    this.establishInputDependencies(definition, newComputation);
    
    // Recursive Recovery (Phase 3 stub)
    // recoverDownstream(newComputation)
  }

  private checkComputationNotExists(id: string): void {
    if (this.computations.has(id) || this.problem_computations.has(id)) {
      throw new NotImplementedError(
        `Computation ${id} already defined. Redefining is not yet supported.`
      );
    }
  }

  protected getOutputConflictInfo(
    definition: ComputationDefinition,
    allowExistingProducerId?: string
  ): { conflictingOutput: VariableId; existingProducer: string } | null {
    for (const out of definition.outputs) {
      const existing = this.variables.get(out) ?? this.problem_variables.get(out);
      if (!existing) continue;
      if (allowExistingProducerId && existing.producer?.id === allowExistingProducerId) {
        continue;
      }
      return {
        conflictingOutput: out,
        existingProducer: existing.producer?.id ?? "source",
      };
    }
    return null;
  }

  protected getComputationShapeFromExisting(comp: Computation): ComputationShape {
    return {
      id: comp.id,
      inputs: Array.from(comp.staticInputs),
      outputs: Array.from(comp.outputs.keys()),
    };
  }

  protected detectCircularDependencyIfAdded(definition: ComputationDefinition): string[] | null {
    const shapes: ComputationShape[] = [];
    for (const comp of this.computations.values()) {
      if (comp.id === definition.id) continue;
      shapes.push(this.getComputationShapeFromExisting(comp));
    }
    // Also include problem computations in graph?
    // If they form a cycle, they are part of the structure.
    for (const comp of this.problem_computations.values()) {
        if (comp.id === definition.id) continue;
        shapes.push(this.getComputationShapeFromExisting(comp));
    }

    shapes.push({ id: definition.id, inputs: definition.inputs, outputs: definition.outputs });

    const graph = buildDependencyGraph(shapes);
    return detectCycleFrom(graph, definition.id);
  }

  protected computeInitialCauseAt(definition: ComputationDefinition): number {
    if (definition.inputs.length === 0) {
      return 0;
    }

    let maxCauseAt = 0;
    for (const inputId of definition.inputs) {
      const inputVariable = this.variables.get(inputId) ?? this.problem_variables.get(inputId);
      if (inputVariable) {
        maxCauseAt = Math.max(maxCauseAt, inputVariable.cause_at);
      }
    }
    return maxCauseAt;
  }

  protected _createOutputVariables(
    definition: ComputationDefinition,
    initialCauseAt: number,
    _indent: number
  ): Map<VariableId, Variable> {
    const outputsMap = new Map<VariableId, Variable>();

    for (const outputId of definition.outputs) {
      // Logic checked by problem detection, but double check safety
      if (this.variables.has(outputId)) {
        throw new Error(
          `Output variable ${outputId} from computation ${definition.id} already exists.`
        );
      }

      const outputVariable = new Variable(outputId, {
        result: { type: "uninitialized" },
        value_at: 0,
        cause_at: initialCauseAt,
        dirty: true,
        producer: null,
        isRecursivelyObserved: false,
      });

      this.variables.set(outputId, outputVariable);
      outputsMap.set(outputId, outputVariable);
    }

    return outputsMap;
  }

  protected countInitialDirtyInputs(definition: ComputationDefinition): {
    initialDirtyInputCount: number;
    allInputsClean: boolean;
  } {
    let initialDirtyInputCount = 0;
    let allInputsClean = true;

    for (const inputId of definition.inputs) {
      const inputVariable = this.variables.get(inputId) ?? this.problem_variables.get(inputId);
      if (!inputVariable) {
         // Should be caught by problem detection
        throw new Error(`Internal error: input ${inputId} should have been validated`);
      }

      if (inputVariable.dirty) {
        initialDirtyInputCount++;
        allInputsClean = false;
      }
    }

    return { initialDirtyInputCount, allInputsClean };
  }

  protected createComputationObject(
    definition: ComputationDefinition,
    staticInputs: Set<VariableId>,
    outputsMap: Map<VariableId, Variable>,
    initialDirtyInputCount: number,
    initialCauseAt: number
  ): Computation {
    const newComputation = new Computation(
      definition.id,
      staticInputs,
      outputsMap,
      definition.body,
      {
        cause_at: initialCauseAt,
        dirtyInputCount: initialDirtyInputCount,
        input_version: 0,
        observeCount: 0,
        dirty: true,
      }
    );

    (newComputation as any).scheduler = this;

    for (const inputId of staticInputs) {
      const variable = this.variables.get(inputId);
      if (variable) {
        newComputation.runtimeInputs.add(variable);
      }
    }

    this.computations.set(definition.id, newComputation);
    return newComputation;
  }

  protected _linkOutputsToProducer(
    outputsMap: Map<VariableId, Variable>,
    computation: Computation,
    _indent: number
  ): void {
    outputsMap.forEach((outputVar) => {
      outputVar.producer = computation;
    });
  }

  protected establishInputDependencies(definition: ComputationDefinition, computation: Computation): void {
    for (const inputId of definition.inputs) {
      const inputVariable = this.variables.get(inputId);
      if (inputVariable) {
        inputVariable.dependents.add(computation);
      }
    }
  }
}