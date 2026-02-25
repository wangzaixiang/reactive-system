# API 参考 (API Reference)

`ReactiveModule` 是与内核交互的主要入口。

## 核心类型

### `VariableId`
*   类型: `string` (Branded Type)
*   描述: 变量的全局唯一标识符。

### `ComputationDefinition`
```typescript
interface ComputationDefinition {
    id: string;              // Computation 的 ID
    inputs: VariableId[];    // 静态依赖列表
    outputs: VariableId[];   // 产出的变量列表
    body: (scope: Scope, signal: AbortSignal) => Promise<Record<string, any>>;
}
```

## 方法 (Methods)

### 定义与注册

#### `defineSource(definition: SourceDefinition)`
定义一个源变量。
*   `definition`: `{ id: VariableId, initialValue?: any }`
*   **注意**: 重复定义已存在的 ID 会抛出异常（除非是热重载模式下的特殊处理）。

#### `defineComputation(definition: ComputationDefinition)`
注册一个计算单元。
*   **行为**: 注册后，系统会自动解析依赖图，并立即调度一次初始计算（如果是 Eager 模式或已被观察）。

### 状态更新

#### `updateSource(id: VariableId, value: any)`
更新源变量的值。
*   触发: 会立即标记所有下游依赖为脏，并调度更新。
*   **原子性**: 它是同步操作，但传播是异步的。

### 数据获取与观察

#### `observe(id: VariableId, callback: Observer): Unsubscribe`
订阅变量的变化。
*   `callback`: `(result: Result<any>) => void`
*   **返回值**: 一个函数，调用它以取消订阅。
*   **作用**: 增加变量的引用计数，使其变为"活跃"状态。

#### `getValue(id: VariableId): Promise<any>`
获取变量的当前值。
*   **行为**:
    *   如果变量是脏的 (Dirty)，会触发重算并等待结果。
    *   如果结果是 `Success`，返回 `value`。
    *   如果结果是 `Error`，**抛出**异常。
    *   如果结果是 `Uninitialized`，抛出异常。
*   **用途**: 一次性获取值（Pull 模式）。

#### `getValueResult(id: VariableId): Promise<Result<any>>`
获取变量的完整结果对象（不抛出异常）。
*   **用途**: 需要处理错误状态的高级场景。

### 调试与内省 (Introspection)

#### `peek(id: VariableId)`
**同步**查看变量的当前快照。
*   **返回**: `{ result: Result<any>, isDirty: boolean }`
*   **警告**: 仅用于调试，**不会**触发计算，也不会等待 Pending 的任务。如果变量是脏的，你看到的就是脏的旧值。

#### `peekComputation(id: string)`
查看计算单元的内部状态。
*   **返回**: 包含 `state` (Idle/Pending), `dirtyInputCount`, `observeCount` 等详细信息。
