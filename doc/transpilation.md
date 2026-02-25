# 代码转译 (Transpilation)

用户在 Code Cell 中编写的 TypeScript 代码不能直接在浏览器或内核中执行。系统需要将其**转译 (Transpile)** 为符合 Computation 协议的函数形式。

## 转译目标

**输入 (Code Cell)**:
```typescript
// ID: cell_1
const tax = 0.1;
const price = 100;
export const total = price * (1 + tax);
console.log("Calculated total");
```

**输出 (Computation Body)**:
```typescript
async function __cell_1_body__(scope, signal) {
  // 1. 作用域注入 (Scope Injection)
  // 系统自动识别依赖 'price' (假设来自上游) 并从 scope 获取
  // const price = await scope.price; <--- 实际上由转译器处理依赖解析

  // 2. 用户代码逻辑
  const tax = 0.1;
  const price = 100; // 在此示例中 price 是局部变量
  const total = price * (1 + tax);

  // 3. 副作用捕获 (Side Effect Capture)
  // console.log 被重写或拦截以收集日志
  scope.console.log("Calculated total");

  // 4. 显式返回导出 (Explicit Return)
  return {
    total: total
  };
}
```

## 转译流程

1.  **解析 (Parsing)**: 使用编译器 (如 `swc` 或 `typescript`) 将 TS 代码解析为 AST。
2.  **依赖分析 (Dependency Analysis)**:
    *   扫描顶层标识符的引用。
    *   如果标识符未在当前作用域定义，则视为**外部依赖**。
    *   将这些外部依赖添加到 `ComputationDefinition.inputs` 列表中。
3.  **代码重写 (Transformation)**:
    *   **Export 重写**: 将 `export const x = ...` 重写为局部变量定义，并在函数末尾收集到 `return { x }` 对象中。
    *   **Await 注入**: 虽然 V3 主要依赖静态定义的 `inputs`，但在高级模式下，为了支持动态导入，可能会将外部变量访问重写为 `await scope.get('var')`。
    *   **Top-level Await**: 将代码包裹在 `async` 函数中，原生支持 `await`。
4.  **生成 (Generation)**: 生成最终的可执行 JS 代码字符串。

## 作用域 (Scope)

`scope` 对象是代码与内核交互的代理：

*   **读取依赖**: 提供对输入变量值的访问。
*   **工具注入**: 注入 `console`, `render` 等平台工具函数。

## 限制与约束

为了保证响应式系统的确定性，转译后的代码应遵循：
*   **无隐式全局访问**: 禁止访问 `window` 或 `document`（通过沙箱或 Linter 强制）。
*   **无未声明的依赖**: 所有外部数据必须通过 Source 变量注入。
