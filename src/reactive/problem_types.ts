import { VariableId, ComputationDefinition } from "./types";
import { Computation } from "./computation";

export type ProblemReason =
  | { type: 'missing-input'; missingInputs: VariableId[] }
  | { type: 'circular-dependency'; cyclePath: string[] }
  | { type: 'invalid-definition'; error: string }
  | { type: 'duplicate-output'; conflictsWith: string };

export interface ProblemComputation extends Computation {
  problemReason: ProblemReason;
  missingInputs?: Set<VariableId>;
  definition: ComputationDefinition; // Store original definition for recovery
}

export interface ProblemDiagnostic {
    computationId: string;
    reason: ProblemReason;
    affectedOutputs: VariableId[];
    downstreamProblems: string[];
    canRecover: boolean;
    recoveryHint?: string;
}

export interface ProblemTrace {
    computationId: string;
    reason: ProblemReason;
    upstreamProblems?: Array<{
        computationId: string;
        outputVariable: VariableId;
        reason: ProblemReason;
    }>;
    rootCause?: {
        computationId: string;
        reason: ProblemReason;
    };
}

export interface GraphHealth {
    totalComputations: number;
    normalComputations: number;
    problemComputations: number;
    totalVariables: number;
    normalVariables: number;
    problemVariables: number;
    rootProblems: Array<{
        computationId: string;
        reason: ProblemReason;
        affectedCount: number;
        canRecover: boolean;
        recoveryHint?: string;
    }>;
    healthScore: number;
}
