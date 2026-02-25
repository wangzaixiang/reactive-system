# Reactive System v3

一个简化的、无毛刺（glitch‑free）的响应式计算引擎实现，提供定义源变量、计算图、调度执行、错误/问题诊断与观察者通知等能力。适合做数据流引擎、依赖追踪或可视化计算内核。

## 主要特性
- 源变量与计算（Computation）定义、重定义与移除。
- 动态依赖追踪与调度执行。
- 中断（abort）与并发调度策略。
- 问题检测/恢复与诊断 API。
- 完整的测试矩阵（见 `tests/` 与 `tests/TEST_CHECKLIST.md`）。

## 安装
本仓库为独立包，默认 `main` 指向 `dist/` 编译产物。

本地开发依赖：
```bash
npm install
npm run build
```

## 快速使用
```ts
import { ReactiveModule } from './src/reactive/reactive_module';

const system = new ReactiveModule();

system.defineSource({ id: 'x', initialValue: 1 });

system.defineComputation({
  id: 'double',
  inputs: ['x'],
  outputs: ['y'],
  body: async (scope) => ({ y: (await scope.x) * 2 }),
});

system.observe('y', (r) => {
  if (r.type === 'success') {
    console.log('y =', r.value);
  }
});

system.updateSource('x', 5); // 触发 y 重新计算
```

## 构建与测试
```bash
npm run build   # 编译到 dist/
npm test        # 运行 vitest
```

## 目录结构
- `src/reactive/`：核心实现（调度、执行、依赖图、问题诊断等）。
- `tests/reactive/`：核心行为与状态机测试。
- `tests/problems/`：问题恢复与诊断相关测试。
- `doc/`：概念、语义与 API 说明。
- `dist/`：编译产物（由 `tsc` 生成）。

## 文档
- `doc/concepts.md`：核心概念与术语。
- `doc/semantics.md`：语义规则与不变量。
- `doc/api-reference.md`：API 概览。
- `doc/transpilation.md`：转译/执行相关说明。

## 许可证
ISC
