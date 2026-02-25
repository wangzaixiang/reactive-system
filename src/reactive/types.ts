// ============================================================================
// Type Definitions
// ============================================================================

export type VariableId = string & { readonly __brand: unique symbol };

// 定义 Result 类型
export type Result<T> =
    | { type: 'success', value: T }
    | { type: 'error', error: any }
    | { type: 'fatal', error: StructuralError }
    | { type: 'uninitialized' }; // 变量从未计算过

// 结构性错误：图结构问题导致无法执行
export interface StructuralError {
    kind: 'structural';
    reason: StructuralErrorReason;
    details: StructuralErrorDetails;
}

export type StructuralErrorReason =
    | 'missing-input'         // 引用了不存在的输入变量
    | 'circular-dependency'   // 参与循环依赖
    | 'invalid-definition'    // 定义本身有问题（如代码语法错误）
    | 'duplicate-output';     // 输出变量与已存在的冲突

export interface StructuralErrorDetails {
    computationId: string;
    missingInputs?: VariableId[];      // 缺失的输入列表
    cyclePath?: string[];              // 循环依赖路径
    definitionError?: string;          // 定义错误描述
    conflictsWith?: string;            // 冲突的 computation ID
}

export function getResultValue(result: Result<any>): any {
    if (result.type === 'success') {
        return result.value;
    }
    else {
        throw new Error("Cannot get value from non-success Result");
    }
}

// 定义 ReactiveModule 的配置选项
export interface ReactiveModuleOptions {
    maxConcurrent?: number;              // 默认 16
    abortStrategy?: 'deferred' | 'immediate'; // 默认 'deferred'
    logLevel?: 'trace' | 'debug' | 'info' | 'error'
    assertInvariants?: boolean;          // 默认 false
}

// 定义源变量的初始定义
export interface SourceDefinition {
    id: VariableId;
    initialValue?: any;
}

// Computation 的状态机
export enum ComputationState {
    Idle = 'idle',
    Pending = 'pending',
    Ready = 'ready',
}

// Computation body 函数的 Scope 接口
export interface Scope {
    [variableId: string]: Promise<any> | any; // 值访问 (Promise based)
    getResult: (variableId: string) => Promise<Result<any>>; // 获取 Result 对象，不抛出异常
}

// Computation body 函数的类型
export type ComputationFn = (scope: Scope, signal: AbortSignal) => Promise<Record<string, any>>;

// 定义 Computation 的定义接口
export interface ComputationDefinition {
    id: string;                                    // Computation ID
    inputs: VariableId[];                          // 静态输入变量列表
    outputs: VariableId[];                         // 输出变量列表
    body: ComputationFn;                           // 计算函数
}

// 观察者回调函数类型
export type Observer = (result: Result<any>) => void; // Observer 接收 Result<any>

// 取消观察的函数类型
export type Unsubscribe = () => void;

// RunningTask - 正在执行的任务
export interface RunningTask {
    taskId: number;                      // 任务唯一ID
    cause_at: number;                    // 任务启动时的 cause_at
    abortController: AbortController;    // 用于取消任务
    promise: Promise<any>;               // 任务 Promise
}
