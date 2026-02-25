export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

export class UninitializedError extends Error {
  constructor() {
    super("UninitializedError");
    this.name = 'UninitializedError';
  }
}

export class CircularDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircularDependencyError';
  }
}

/**
 * 表示功能尚未实现但计划在未来支持
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

/**
 * 表示计算任务被中止（取消）
 *
 * 这是一个预期的异常，用于处理以下场景：
 * - Aggressive Cancellation: 当 cause_at 更新时，中止过期的运行中任务
 * - Pull-based Evaluation: 当用户取消 getValue() 操作时
 *
 * 契约：
 * - 这不是真正的错误，而是正常的控制流
 * - 不应该记录堆栈跟踪（避免日志噪音）
 * - Computation 保持 dirty 状态，等待重新调度
 */
export class AbortException extends Error {
  constructor(message: string = 'Task was aborted') {
    super(message);
    this.name = 'AbortException';
  }
}

