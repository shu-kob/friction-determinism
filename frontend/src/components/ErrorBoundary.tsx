import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { sendTelemetry } from '../utils/telemetry';

interface Props {
  children: ReactNode;
  sessionId: string;
  userId?: string;
  currentRoute: string;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    errorMessage: '',
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, errorMessage: error.message };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[ErrorBoundary] Caught crash error:', error, errorInfo);

    // Send telemetry detailing the schema/component exception
    sendTelemetry({
      session_id: this.props.sessionId,
      user_id: this.props.userId,
      current_route: this.props.currentRoute,
      timestamp: new Date().toISOString(),
      revision_id: 'v1',
      is_rage_click: 0,
      is_maigo: 0,
      schema_validation_error: 1,
      stay_duration_seconds: 0,
      regenerate_count: 0,
      raw_error_message: `${error.name}: ${error.message}\nStack: ${errorInfo.componentStack || ''}`,
    });
  }

  public override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="fallback-box">
          <div className="fallback-title">
            <span className="status-dot red pulse"></span>
            Smart Fallback Active: AI is taking a deep breath...
          </div>
          <div className="fallback-content">
            <p>The reasoning LLM returned a structured data syntax anomaly. The SRE Error Shield has successfully prevented a white-out.</p>
            <div style={{ 
              marginTop: '12px', 
              padding: '10px', 
              borderRadius: '6px', 
              background: 'rgba(0,0,0,0.4)', 
              fontSize: '12px', 
              fontFamily: 'var(--font-mono)', 
              color: 'var(--accent-red)',
              overflowX: 'auto',
              border: '1px solid rgba(239, 68, 68, 0.2)'
            }}>
              Intercepted: {this.state.errorMessage}
            </div>
            <button 
              className="btn btn-secondary" 
              style={{ marginTop: '16px', padding: '6px 14px', fontSize: '12px' }}
              onClick={() => this.setState({ hasError: false, errorMessage: '' })}
            >
              Reset Shield & Continue
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
export default ErrorBoundary;
