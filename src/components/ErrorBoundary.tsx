import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** 用于在切换 tab 时 reset 内部错误态 */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

/**
 * 把子树的 throw 兜住，避免一抛就整个 App 白屏。打印到控制台方便调试。
 * React 的错误边界必须是 class component——hooks 写不了。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error("[stela] render error", error, info);
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-sm">
          <div className="font-medium text-destructive">
            Something went wrong rendering this view
          </div>
          <pre className="max-w-[560px] whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/5 p-3 text-[11px] text-destructive">
            {this.state.error.stack ?? this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="rounded-md border border-border bg-background px-3 py-1 text-xs hover:bg-accent"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
