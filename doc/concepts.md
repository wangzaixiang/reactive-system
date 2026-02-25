# 核心概念 (Core Concepts)

响应式内核 (Reactive Kernel) 是系统的"大脑"，负责管理所有数据的状态、计算逻辑以及依赖关系。它的设计独立于任何 UI 框架或文档模型，是一个纯粹的数据流引擎。

## 1. 变量 (Variable)

变量是响应式系统中的最小状态单元。每个变量都有一个全局唯一的 `VariableId`。

### 变量类型

*   **源变量 (Source Variable)**:
    *   **定义**: 系统的"根"状态，不由其他变量计算得出。
    *   **来源**: 通常来自用户输入（如 `<nb-input>` 的值）、外部数据源加载结果、或系统常量。
    *   **操作**: 只能通过 `updateSource` API 显式修改。

*   **计算变量 (Computed Variable)**:
    *   **定义**: 由 **Computation** (计算) 产生的输出结果。
    *   **来源**: 它是函数的产物。一个 Computation 可以产生多个计算变量（例如一个代码块导出多个变量）。
    *   **操作**: **不可变 (Immutable)**。外部无法直接修改计算变量的值，它们只能随着上游依赖的变化而自动重新计算。

## 2. 计算 (Computation)

计算是将输入转化为输出的逻辑单元。

*   **结构**:
    *   **Inputs**: 输入变量列表（依赖项）。
    *   **Body**: 一个异步函数 `(scope, signal) => Promise<Outputs>`。
    *   **Outputs**: 输出变量列表。
*   **特性**:
    *   **纯函数 (Pure Function)**: 给定相同的输入，总是产生相同的输出（除了 `random` 或 `time` 等副作用，但系统尽量将其视为纯函数处理）。
    *   **无状态 (Stateless)**: Computation 本身不存储状态，状态存储在输出的 Variable 中。
    *   **异步 (Async)**: 原生支持异步操作（如 `fetch`），系统会自动处理等待和竞态问题。

## 3. 依赖图 (Dependency Graph)

系统自动维护一个 **有向无环图 (DAG)** 来表示变量与计算之间的关系。

*   **节点**: Variable 和 Computation。
*   **边**: Data Flow (数据流向)。
    *   `Variable A` -> `Computation X` (A 是 X 的输入)
    *   `Computation X` -> `Variable B` (B 是 X 的输出)
*   **自动追踪**: 当你定义一个 Computation 时，需声明其 `inputs`。系统根据这些声明构建图谱。

## 4. 响应式更新机制 (Reactivity)

系统采用 **"推-拉结合" (Push-Pull Hybrid)** 的更新策略，以平衡实时性和性能。

1.  **Push (标记脏状态)**:
    *   当源变量 `A` 更新时，系统会立即遍历依赖图，将所有下游的 Computation 标记为 **Dirty (脏)**。
    *   这一步非常快，因为不涉及实际计算。

2.  **Pull / Schedule (调度执行)**:
    *   系统调度器会根据拓扑顺序，从上到下执行脏的 Computation。
    *   **惰性求值 (Lazy Evaluation)**: 如果一个脏的 Computation 没有被任何"活跃"的观察者（如 UI 组件）监听，系统可能会选择跳过它的执行（Pruning），直到有人需要它的值。

## 5. 观察者 (Observer)

外界（通常是 UI 组件）通过 **观察 (Observe)** 机制接入响应式系统。

*   **订阅**: `kernel.observe('varId', callback)`。
*   **通知**: 当变量的值发生实质性变化（Reference Equality check）时，`callback` 被调用。
*   **活跃性**: 只有被观察的变量（或被观察变量所依赖的上游变量）才会被视为"活跃 (Active)"，从而触发实际的重算。
