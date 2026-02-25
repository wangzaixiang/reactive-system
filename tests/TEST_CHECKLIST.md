# V3 响应式系统测试用例清单

本文档基于 V3 设计文档（`doc/reactive/v3/`）整理，涵盖响应式系统的所有核心功能和边界场景。

## 1. 基础场景 (Basic Scenarios)

- ✅ **简单链式计算 (Simple Chain)**: x → y → z，验证顺序传播和正确性
- ✅ **钻石拓扑 (Diamond Topology)**: a → b, a → c, b+c → d，验证无重复计算（glitch-free）
- ✅ **多输出计算 (Multiple Outputs)**: 一个 Computation 产生多个 outputs，验证同步更新
- **单变量多消费者**: 一个 source 被多个 computations 依赖，验证通知机制
- **深层嵌套计算链**: x → y1 → y2 → ... → y10，验证深度传播稳定性

## 2. 状态转换 (State Transitions)

- **Idle → Pending**: 输入变 dirty 时，computation 转 Pending
- **Pending → Ready**: 所有输入变 clean 时，computation 转 Ready
- **Ready → Running**: 从 readyQueue 取出并开始执行时
- **Running → Idle**: 执行成功完成，outputs 更新后
- **Running → Pending**: 执行被中止且仍 dirty 时，重新进入 Pending
- **非法状态转换检测**: 验证 INV-C5（例如：Idle 状态不应有 runningTask）

## 3. 剪枝优化 (Pruning Optimizations)

### 3.1 Input Pruning
- **首次执行**: input_version=0 时，必须执行
- **输入未变化**: 所有 runtimeInputs 的 value_at 都 <= input_version，跳过执行
- **部分输入变化**: 至少一个 input 的 value_at > input_version，重新执行

### 3.2 Output Pruning
- **输出值未变化**: 执行后 deepEqual 检测到值相同，不递增 value_at
- **输出值变化**: 递增 value_at，触发下游传播
- **多输出原子性**: 所有变化的 outputs 共享同一 value_at

### 3.3 Visibility Pruning
- ✅ **未观察不执行**: 没有 observer 的 computation 不应执行
- ✅ **观察后执行**: 调用 observe() 后，computation 被标记为 observed 并执行
- ✅ **中间节点传播**: x→y→z 只观察 z，y 也应执行（因为 z 需要它）
- ✅ **钻石拓扑观察**: 钻石图只观察 d，所有上游（b、c）都应执行
- ✅ **多输出部分观察**: 只观察一个 output，整个 computation 也应执行
- **取消观察后停止**: unsubscribe 后，如果没有其他 observer，应停止执行（TODO）

## 4. 调度与并发 (Scheduling & Concurrency)

- **FIFO 队列顺序**: readyQueue 按 FIFO 顺序调度
- **并发限制**: 验证 maxConcurrent 参数生效（例如设为 2，最多 2 个同时运行）
- **独立分支并发**: 钻石图中 b 和 c 应并发执行（无依赖关系）
- **依赖顺序保证**: x→y→z 严格按顺序执行（有依赖关系）
- **激进取消 (Aggressive Abort)**: cause_at 增加时，立即中止 runningTask
  - ✅ **长耗时计算中断**: 正在运行的计算（模拟长耗时 IO）被上游更新中断，不产生旧结果。
  - ✅ **新值正确传播**: 中断后计算被重新调度，并产生基于最新输入的新结果。
  - ✅ **中断后的状态**: 被中止的 computation 应该保持 dirty，等待重新调度。
  - ✅ **多次更新连续中断**: 连续快速更新导致计算多次中断和重新调度。
- **延迟取消 (Deferred Abort)**: abortStrategy=deferred 时，等待当前任务完成

## 5. 错误处理 (Error Handling)

- ✅ **计算抛出错误**: 验证错误传播到所有 outputs（type='error'）
- **AbortError 不传播**: 中止任务不应将 AbortError 传播到 outputs
- **错误状态清理**: 错误后 computation 应变为 Idle（不应无限重试）
- **错误后重新计算**: 输入变化后，应重新尝试计算（即使之前出错）
- **循环依赖检测**: 定义时检测 A→B→A 循环，抛出友好错误

## 6. 动态依赖 (Dynamic Dependencies)

- **条件分支访问**: `if (cond) { await scope.x } else { await scope.y }`，验证 runtimeInputs 正确追踪
- **未访问输入清理**: 第二次执行时不再访问 x，应从 runtimeInputs 中移除
- **动态依赖 + Input Pruning**: 只有实际访问的输入变化才触发重新执行
- **静态输入边界**: 动态访问的变量必须在 staticInputs 中（否则报错）
- ⚠️ **动态访问时的 cause_at 提升**: 访问新变量时，如果其 cause_at 更大，应更新 comp.cause_at（维持 INV-C2）

## 7. Pull-based 求值 (Pull-based Evaluation)

- **getValue() 触发计算**: 调用 getValue() 时，如果 dirty 则触发计算
- **共享 runningTask**: 多个 getValue() 调用共享同一任务 Promise
- **AbortError 重试**: getValue() 遇到 AbortError 自动重试（retry=true）
- **其他错误抛出**: getValue() 遇到非 Abort 错误，直接抛出
- **getValueResult() 不抛错**: 返回 Result 对象，不抛出异常

## 8. Invariants 验证 (Invariants Validation)

- **INV-V1**: Source Variable 永远 clean（producer=null 时 dirty=false）
- **INV-V2**: value_at 的有效性（value_at=0 仅当 result=uninitialized）
- **INV-V3**: cause_at 单调性（cause_at 不应减少）
- **INV-C1**: runtimeInputs ⊆ staticInputs
- **INV-C2**: comp.cause_at >= max(inputs.cause_at)，且 outputs.cause_at = comp.cause_at
- **INV-C3**: comp.dirty = outputs.all(dirty)
- **INV-C4**: dirtyInputCount = runtimeInputs.filter(dirty).length
- **INV-C5**: 状态转换约束（详见 reactive_module.ts 注释）

## 9. 输入验证 (Input Validation)

- **未定义变量访问**: 访问不存在的变量，应抛出友好错误
- **重复定义检测**: 重复 defineSource/defineComputation，应报错
- **输入输出冲突**: computation 的 input 和 output 不能重叠

## 10. Observer 机制 (Observer Mechanism)

- **立即通知**: observe() 时如果变量已有值，立即调用 callback
- **Result 类型通知**: callback 接收 `Result<any>`（包含 type/value/error）
- **批量通知**: updateSource() 后，所有受影响的 observers 都应收到通知
- **unsubscribe 生效**: 调用返回的 unsubscribe 函数后，不再收到通知
- **观察 uninitialized 变量**: 观察未初始化变量，不应立即触发 callback

## 11. 调试工具 (Debugging Tools)

- ✅ **peek() 无副作用**: 调用 peek() 不触发任何计算
- ✅ **peek() 返回正确状态**: 返回 result 和 isDirty
- ✅ **peek() 支持错误结果**: 可以 peek 到 type='error' 的 result

## 12. 递归观察传播 (Recursive Observation Propagation)

- **observe() 向上传播**: 观察 z 时，自动标记 y、x 为 isRecursivelyObserved
- **自适应输入选择**: 首次执行前用 staticInputs，执行后用 runtimeInputs
- **钻石拓扑正确性**: 观察 d 时，a、b、c 都应标记为 observed
- **自动调度 ready 的 computation**: propagateObservedUpward 后，ready 的 computation 自动加入 readyQueue

## 13. 时间一致性 (Temporal Consistency) ⭐ 新增

**核心不变量**: INV-C2: `comp.cause_at >= max(inputs.cause_at)` 且 `outputs.cause_at = comp.cause_at`

时间一致性确保响应式系统中的因果关系正确性，防止"时间倒流"（使用旧数据计算新结果）。

### 13.1 定义时的时间一致性

- **defineComputation 初始 cause_at**: 新 computation 的 cause_at 必须 = max(staticInputs.cause_at)
- **outputs 初始 cause_at 同步**: 所有 outputs 的 cause_at = computation 的 cause_at

### 13.2 传播时的时间一致性

- **markDirty 传播 cause_at**: 向下游传播时，comp.cause_at = max(current, t)
- **outputs cause_at 同步**: markDirty 时所有 outputs 的 cause_at = t
- **updateSource 触发传播**: source 更新时，cause_at 更新并触发下游传播

### 13.3 动态依赖的时间一致性 ⚠️ 关键场景

- ⚠️ **动态访问新变量时的 cause_at 提升**:
  - 问题：computation 执行中通过 `scope.newVar` 访问一个不在 runtimeInputs 中的变量
  - 如果 `newVar.cause_at > comp.cause_at`，需要提升 `comp.cause_at`
  - 同时需要同步更新所有 `outputs.cause_at`
  - 当前实现缺陷：`trackVariableAccess` 方法未处理此场景

- **示例场景**:
  ```typescript
  // 1. x = 1, y = 2
  // 2. z 首次执行只访问 x，z.cause_at = T1
  // 3. y 更新，y.cause_at = T5 (> T1)
  // 4. x 更新，触发 z 重新计算
  // 5. z 这次访问 y（动态依赖）
  // 6. 问题：如果不更新 z.cause_at，违反 INV-C2
  //    因为 z.cause_at (T1) < y.cause_at (T5)
  ```

- **修复需求**:
  ```typescript
  // 在 trackVariableAccess 中添加：
  if (!comp.runtimeInputs.has(variable)) {
    comp.runtimeInputs.add(variable);
    variable.dependents.add(comp);

    // ✅ 维持 INV-C2
    if (variable.cause_at > comp.cause_at) {
      comp.cause_at = variable.cause_at;
      // 同步 outputs
      for (const output of comp.outputs.values()) {
        output.cause_at = comp.cause_at;
      }
    }

    if (variable.dirty) {
      comp.dirtyInputCount++;
    }
  }
  ```

### 13.4 执行完成时的时间一致性

- **executeComputation 后 cause_at 同步**: 所有 outputs 的 cause_at = comp.cause_at
- **input_version 更新**: 执行完成后，comp.input_version = max(runtimeInputs.value_at)

### 13.5 复杂拓扑的时间一致性

- **钻石拓扑 (Diamond Topology)**: a → b, a → c, b+c → d
  - 验证 d.cause_at >= max(b.cause_at, c.cause_at)
  - 多次更新后仍保持一致性

- **长链传播 (Long Chain)**: x → y1 → y2 → ... → yn
  - 每一级的 cause_at 正确传播
  - 末端 yn 的 cause_at 反映源头 x 的更新

- **并发更新场景**: 多个 source 同时更新
  - 最终状态的 cause_at 应反映所有更新
  - 不应出现部分更新的不一致状态

### 13.6 单调性验证

- **cause_at 单调递增 (INV-V3)**: 变量的 cause_at 只能增加，不能减少
- **多次更新保持单调性**: 连续多次 updateSource，cause_at 应单调递增
- **错误不影响单调性**: 即使 computation 出错，cause_at 仍应保持单调

### 13.7 边界场景

- **空输入 computation**: 没有 inputs 的 computation，cause_at = 0
- **循环拓扑检测**: 检测到循环时，不应影响已有的 cause_at 值
- **取消任务时的 cause_at**: abortOutdatedTask 基于 cause_at 决策，验证正确性

---

## 测试状态说明

- ✅ 已完成并通过
- ⏳ 进行中
- ⏸️ 待实现
- ⚠️ 受阻/发现问题
- 🔄 需重做

## 测试文件组织

建议按以下结构组织测试文件：

```
packages/v3/tests/reactive/
├── phase_1_basic.test.ts              # 基础场景（已完成）
├── state_transitions.test.ts          # 状态转换测试
├── pruning/
│   ├── input_pruning.test.ts
│   ├── output_pruning.test.ts
│   └── visibility_pruning.test.ts     # Visibility Pruning（已完成）
├── scheduling.test.ts                 # 调度与并发
├── error_handling.test.ts             # 错误处理
├── dynamic_dependencies.test.ts       # 动态依赖
├── pull_evaluation.test.ts            # Pull-based 求值
├── invariants.test.ts                 # Invariants 验证
├── input_validation.test.ts           # 输入验证
├── observer.test.ts                   # Observer 机制
├── peek.test.ts                       # 调试工具（已完成）
└── temporal_consistency.test.ts       # ⭐ 时间一致性（新增）
```

## 参考文档

- `doc/reactive/v3/reactive-system-spec-v3.md`: 完整规范
- `doc/reactive/v3/design-decisions.md`: 设计决策
- `doc/reactive/v3/algorithms.md`: 核心算法
- `doc/reactive/v3/invariants.md`: 不变量定义
