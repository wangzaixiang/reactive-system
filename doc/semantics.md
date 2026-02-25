# V3 语义与模型 (Semantics & Models)

Reactive Kernel V3 引入了更严格的状态机和一致性模型，以解决异步计算中的竞态条件（Race Conditions）和资源浪费问题。

## 1. 三态模型 (3-State Model)

每个 Computation 在运行时总是处于以下三种状态之一：

| 状态 | 标识 | 描述 |
| :--- | :--- | :--- |
| **Idle** | `idle` | **空闲/就绪**。计算已完成，结果是最新的（或尚未运行过但无待处理变更）。输出变量持有有效值（或 uninitialized）。 |
| **Pending** | `pending` | **计算中**。Body 函数正在执行。此时输出变量仍持有*上一次*的值（为了 UI 稳定性，不会闪烁为空）。 |
| **Ready** | `ready` | **(内部状态)** 这是一个瞬态，表示计算已完成但尚未提交到全局状态。通常对外部不可见，外部看到的瞬间即变为 `idle`。 |

> **注意**: V3 取消了 `Error` 状态。错误被视为一种特殊的 **Result Value**。即使计算抛出异常，Computation 本身也会回到 `Idle` 状态，只是其输出变量携带了 `Result.Error`。

## 2. Result 对象 (Result Object)

所有的变量值都被包装在 `Result<T>` 对象中，以统一处理成功、失败和系统性错误。

```typescript
type Result<T> =
  | { type: 'success', value: T }         // 计算成功
  | { type: 'error', error: any }         // 代码抛出异常 (Runtime Error)
  | { type: 'fatal', error: StructuralError } // 结构性错误 (如循环依赖、缺输入)
  | { type: 'uninitialized' };            // 尚未初始化
```

**设计意图**:
*   **异常即数据**: 下游计算可以消费上游的错误（例如：`isLoading` 或 `error` 状态指示器），而不会导致整个依赖链崩溃。
*   **类型安全**: 强制开发者处理潜在的错误情况。

## 3. SPOT 原则 (Single Point Of Truth)

**单一事实来源**。

*   在任何时刻，对于给定的 Variable Id，内核中**只有一份**确定的状态记录。
*   即使在并发执行（Concurrent Execution）场景下，多个相同的 Computation 可能被触发（例如快速连续输入），系统通过 `cause_at` 时间戳和 `AbortController` 确保只有最新的计算任务被视为有效，且只有最新的结果会被写入状态库。

## 4. 激进取消 (Aggressive Cancellation)

由于计算通常是昂贵的（涉及网络请求或大数据处理），V3 内核实现了激进的取消策略。

*   **机制**: 每个 Computation 任务启动时都会收到一个 `AbortSignal`。
*   **触发**: 一旦 Computation 的输入发生变更（意味着当前正在运行的任务产生的结果将是过期的），系统会**立即**触发旧任务的 `abortController.abort()`。
*   **用户代码协作**: 用户编写的代码（特别是 `fetch` 或长循环）应响应 `signal.aborted`，以便及时释放资源。

## 5. 剪枝优化 (Pruning)

为了最小化不必要的计算，系统实现了多级剪枝：

1.  **输入剪枝 (Input Pruning)**:
    *   在执行 Computation 前，检查所有输入变量的值是否真的发生了变化（基于引用相等性 `===`）。
    *   如果所有输入都与上次执行时相同，直接跳过执行，标记为 Clean。

2.  **输出剪枝 (Output Pruning)**:
    *   计算完成后，对比新结果与旧结果。
    *   如果结果相同（例如 `x` 从 `5` 变为 `5`），则**不传播**脏标记给下游。下游依赖将保持 Clean 状态。

3.  **活跃性剪枝 (Liveness Pruning)**:
    *   基于引用计数 (`observeCount`)。
    *   如果一个 Computation 的输出（及其所有下游）都没有被任何外部 Observer (UI) 监听，该计算可能被推迟执行或完全跳过（Lazy）。
