import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * 界面出错时的兜底（C-50）：以前某个组件抛错整个窗口就白屏，只能关掉重开。
 * 现在显示一页说明，可以「重新加载界面」；数据都在后端，重新加载不会丢。
 * 错误详情折叠着，方便用户复制给开发者；里面只有组件栈，没有 Token 之类的东西。
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; stack: string }> {
  override state: { error: Error | null; stack: string } = { error: null, stack: "" };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("[renderer] 界面出错", error);
    this.setState({ stack: info.componentStack ?? "" });
  }

  override render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    const detail = `${error.name}: ${error.message}\n${stack}`.trim();
    return (
      <div className="splash splash-failed" role="alert">
        <h1>界面出了点问题</h1>
        <p>你的聊天、讨论和笔记都已经保存，不会丢。点下面的按钮重新加载界面就能继续用。</p>
        <p>
          <button type="button" className="button-primary" onClick={() => location.reload()}>
            重新加载界面
          </button>
        </p>
        <details className="splash-detail">
          <summary>错误详情（反馈问题时可以复制给开发者）</summary>
          <pre>{detail}</pre>
        </details>
      </div>
    );
  }
}
