import { Component, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[Pi Agent UI] Render error', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="app-crash">
          <div className="app-crash-panel">
            <h1>Pi Agent UI hit a display error</h1>
            <p>
              The chat service is still running, but one saved message could not be drawn.
              Reloading may help after the bad message is fixed.
            </p>
            <pre>{this.state.error.message}</pre>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
