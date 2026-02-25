# Repository Guidelines

## Project Structure & Module Organization
- `src/reactive/`：核心实现（调度、执行、依赖图、问题诊断等）。
- `tests/reactive/`：核心行为与状态机测试。
- `tests/problems/`：问题恢复与诊断相关测试。
- `tests/TEST_CHECKLIST.md`：测试覆盖清单与场景索引。
- `doc/`：概念、语义、API 与转译说明。
- `dist/`：`tsc` 编译产物，请勿手工修改。

## Build, Test, and Development Commands
- `npm run build`：使用 `tsc` 生成 `dist/`。
- `npm test`：运行 `vitest` 全量测试。

## Coding Style & Naming Conventions
- 语言为 TypeScript，`package.json` 中为 `commonjs` 模式。
- 缩进与空格请以当前文件为准（多数文件为 4 空格），避免一次性大范围格式化。
- 文件命名倾向 `snake_case`（如 `module_execution.ts`）。
- 类型/类用 PascalCase，函数/变量用 camelCase。
- 测试文件命名为 `*.test.ts`。

## Testing Guidelines
- 测试框架：`vitest`。
- 优先在对应目录补充用例：行为/状态机放 `tests/reactive/`，问题与诊断放 `tests/problems/`。
- 新增或覆盖场景时，同步更新 `tests/TEST_CHECKLIST.md` 中的条目。

## Commit & Pull Request Guidelines
- 当前工作区未包含 Git 历史，无法提取既有提交规范。
- 建议提交信息使用简洁动词开头的祈使句式，必要时加范围标识（例如 `reactive:`）。
- PR 描述应包含变更摘要、动机/影响、已运行的测试命令，并关联对应问题或清单条目；行为变更需同步更新 `doc/`。

## Documentation & Configuration Tips
- 变更核心语义或对外 API 时，请同步更新 `doc/` 下相关说明。
- `tsconfig.json` 继承上级配置，新增编译选项需考虑全局影响。
