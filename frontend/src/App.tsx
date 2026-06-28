import { useState, useEffect, useRef } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useLocation } from 'react-router-dom';
import { Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend
} from 'chart.js';
import { useRageClick } from './hooks/useRageClick';
import { useMaigo } from './hooks/useMaigo';
import { sendTelemetry } from './utils/telemetry';
import { ErrorBoundary } from './components/ErrorBoundary';
import type { ChatMessage } from './types';
import { 
  Activity, 
  Layers, 
  MessageSquare, 
  Settings as SettingsIcon, 
  User as UserIcon, 
  AlertTriangle,
  RefreshCw,
  Send,
  Zap,
  Smile,
  Frown
} from 'lucide-react';

// Register Chart.js elements
ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend
);

// Subcomponent to trigger ErrorBoundary if a message is marked as broken (JSON Parse Fail)
function MessageRenderer({ message }: { message: ChatMessage }) {
  if (message.isBroken) {
    throw new Error(
      "JSON Parse Error: Unexpected end of input at line 5 column 10 (Zod Schema Validation Failure: response body missing expected closing brackets)"
    );
  }
  return <div style={{ whiteSpace: 'pre-wrap' }}>{message.text}</div>;
}

function Navigation() {
  const location = useLocation();
  return (
    <nav className="navbar">
      <div className="container navbar-inner">
        <div className="navbar-logo">
          <Activity className="text-cyan pulse" size={24} />
          <span className="gradient-text-cyan gradient-text-glow">Friction.SRE</span>
        </div>
        <div className="navbar-nav">
          <Link to="/" className={`nav-link ${location.pathname === '/' ? 'active' : ''}`}>
            <MessageSquare size={16} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
            AI Chat
          </Link>
          <Link to="/settings" className={`nav-link ${location.pathname === '/settings' ? 'active' : ''}`}>
            <SettingsIcon size={16} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
            Settings
          </Link>
          <Link to="/profile" className={`nav-link ${location.pathname === '/profile' ? 'active' : ''}`}>
            <UserIcon size={16} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
            Profile
          </Link>
          <Link to="/admin" className={`nav-link ${location.pathname === '/admin' ? 'active' : ''}`}>
            <Layers size={16} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
            UXOps Cockpit
          </Link>
        </div>
      </div>
    </nav>
  );
}

function ChatPage({ sessionId }: { sessionId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      sender: 'ai',
      text: 'Hello! I am a deep reasoning AI assistant. Send a message, and I will output my findings in a structured format.',
      timestamp: new Date().toISOString()
    }
  ]);
  const [input, setInput] = useState('');
  const [isBrokenMode, setIsBrokenMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const regenerateCount = useRef(0);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const stayStartTime = useRef(Date.now());

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const sendMsg = async (textToSend: string, forceBroken = isBrokenMode) => {
    if (!textToSend.trim()) return;

    // Get the last AI response text for semantic context
    const lastAiMsg = [...messages].reverse().find(m => m.sender === 'ai')?.text || '';

    // Add user message
    const userMsgId = crypto.randomUUID();
    const newMessages = [
      ...messages,
      {
        id: userMsgId,
        sender: 'user' as const,
        text: textToSend,
        timestamp: new Date().toISOString()
      }
    ];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    try {
      const response = await fetch('/api/mock-llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message: textToSend, 
          broken: forceBroken,
          lastAiMessage: lastAiMsg,
          sessionId: sessionId
        })
      });

      const text = await response.text();
      let parsed: any;
      let isBrokenJSON = false;

      try {
        parsed = JSON.parse(text);
      } catch (err) {
        console.error('Failed to parse JSON response:', err);
        isBrokenJSON = true;
      }

      setLoading(false);

      if (isBrokenJSON) {
        // Mark message as broken to trigger the ErrorBoundary when rendered
        setMessages(prev => [
          ...prev,
          {
            id: crypto.randomUUID(),
            sender: 'ai',
            text: text, // Raw broken payload
            timestamp: new Date().toISOString(),
            isBroken: true
          }
        ]);
      } else {
        setMessages(prev => [
          ...prev,
          {
            id: crypto.randomUUID(),
            sender: 'ai',
            text: parsed.reply,
            timestamp: new Date().toISOString()
          }
        ]);
      }

      // Send standard healthy telemetry (or telemetry is sent by hook on error)
      const stayDuration = Math.round((Date.now() - stayStartTime.current) / 1000);
      sendTelemetry({
        session_id: sessionId,
        user_id: 'user_poc_1',
        current_route: '/',
        timestamp: new Date().toISOString(),
        revision_id: 'v1',
        is_rage_click: 0,
        is_maigo: 0,
        schema_validation_error: isBrokenJSON ? 1 : 0,
        is_context_correction: 0, // Let backend merge the async cache
        is_context_deepening: 0,  // Let backend merge the async cache
        stay_duration_seconds: stayDuration,
        regenerate_count: regenerateCount.current,
        raw_error_message: isBrokenJSON ? `JSON Parse Error: Unexpected end of input at response text: ${text.substring(0, 100)}...` : undefined
      });
      // Reset start time
      stayStartTime.current = Date.now();

    } catch (error: any) {
      setLoading(false);
      console.error('API Error:', error);
    }
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    sendMsg(input);
  };

  const handleRegenerate = () => {
    regenerateCount.current += 1;
    const lastUserMsg = [...messages].reverse().find(m => m.sender === 'user');
    if (lastUserMsg) {
      sendMsg(lastUserMsg.text);
    } else {
      sendMsg("Explain the telemetry schema architecture.");
    }
  };

  return (
    <div className="container chat-wrapper">
      <div className="glass-panel" style={{ padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '18px' }}>Active Session Sandbox</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>UUID: {sessionId}</p>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <div className="switch-container">
            <span style={{ fontSize: '13px', fontWeight: 600 }}>
              {isBrokenMode ? '🔴 Bug Mode: ON (Malformed JSON)' : '⚪ Bug Mode: OFF (Normal JSON)'}
            </span>
            <label className="switch">
              <input type="checkbox" checked={isBrokenMode} onChange={(e) => setIsBrokenMode(e.target.checked)} />
              <span className="slider"></span>
            </label>
          </div>
          <button className="btn btn-secondary" onClick={handleRegenerate}>
            <RefreshCw size={14} />
            Regenerate ({regenerateCount.current})
          </button>
        </div>
      </div>

      <div className="glass-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="chat-messages">
          {messages.map((msg) => (
            <div key={msg.id} className={`message ${msg.sender === 'user' ? 'message-user' : 'message-ai'}`}>
              <ErrorBoundary sessionId={sessionId} currentRoute="/">
                <MessageRenderer message={msg} />
              </ErrorBoundary>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', textAlign: 'right', marginTop: '6px' }}>
                {new Date(msg.timestamp).toLocaleTimeString()}
              </div>
            </div>
          ))}
          {loading && (
            <div className="message message-ai" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div className="status-dot green pulse"></div>
              <span>AI is thinking...</span>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <form onSubmit={handleSend} className="chat-input-area">
          <input
            type="text"
            className="input"
            style={{ flex: 1 }}
            placeholder="Type your message here..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit" className="btn btn-primary">
            <Send size={16} />
            Send
          </button>
        </form>
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', gap: '16px', fontSize: '13px', color: 'var(--text-secondary)' }}>
        <span>💡 Trigger <strong>Rage Click</strong> by clicking anywhere 5 times in 1s.</span>
        <span>💡 Navigate pages repeatedly to trigger <strong>Maigo Detector</strong>.</span>
      </div>
    </div>
  );
}

function SettingsPage() {
  return (
    <div className="container dummy-page">
      <div className="glass-panel" style={{ padding: '40px', maxWidth: '500px', width: '100%' }}>
        <SettingsIcon size={48} className="text-secondary" style={{ marginBottom: '16px' }} />
        <h1>System Settings</h1>
        <p style={{ color: 'var(--text-secondary)' }}>This dummy view exists to simulate multi-route user workflows (A → B → C) and test the Maigo route-bouncing sensor.</p>
        <div style={{ marginTop: '24px' }}>
          <Link to="/" className="btn btn-primary">Go to Chat</Link>
        </div>
      </div>
    </div>
  );
}

function ProfilePage() {
  return (
    <div className="container dummy-page">
      <div className="glass-panel" style={{ padding: '40px', maxWidth: '500px', width: '100%' }}>
        <UserIcon size={48} className="text-secondary" style={{ marginBottom: '16px' }} />
        <h1>User Profile</h1>
        <p style={{ color: 'var(--text-secondary)' }}>This dummy view exists to simulate multi-route user workflows (A → B → C) and test the Maigo route-bouncing sensor.</p>
        <div style={{ marginTop: '24px' }}>
          <Link to="/settings" className="btn btn-secondary">Go to Settings</Link>
        </div>
      </div>
    </div>
  );
}

interface MetricRow {
  revision_id: string;
  total_sessions: number;
  rage_click_rate: number;
  maigo_rate: number;
  smart_fallback_rate: number;
  context_correction_rate: number;
  context_deepening_rate: number;
  avg_stay_duration: number;
  total_regenerate_press: number;
}

interface ProgressiveState {
  currentPhase: 'none' | 'canary' | 'ab-test' | 'blue-green';
  traffic: { v1: number; v2: number };
  v2RevisionName: string;
  v1RevisionName: string;
  phaseStartTime: number | null;
  canaryDurationMs: number;
  history: Array<{ timestamp: string; event: string; message: string }>;
}

function AdminPage() {
  const [metrics, setMetrics] = useState<MetricRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState('local');
  const [progState, setProgState] = useState<ProgressiveState | null>(null);
  const [canarySecondsLeft, setCanarySecondsLeft] = useState<number | null>(null);

  const fetchMetrics = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/admin/ux-metrics?hours=24');
      const data = await response.json();
      setMetrics(data.metrics || []);
      setDataSource(data.source);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchProgressiveStatus = async () => {
    try {
      const response = await fetch('/api/admin/progressive-status');
      const data = await response.json();
      setProgState(data);
      
      // Calculate remaining time for Canary phase
      if (data.currentPhase === 'canary' && data.phaseStartTime) {
        const elapsed = Date.now() - data.phaseStartTime;
        const total = data.canaryDurationMs;
        const remaining = Math.max(0, Math.ceil((total - elapsed) / 1000));
        setCanarySecondsLeft(remaining);
      } else {
        setCanarySecondsLeft(null);
      }
    } catch (err) {
      console.error('Failed to fetch progressive status:', err);
    }
  };

  useEffect(() => {
    fetchMetrics();
    fetchProgressiveStatus();
    
    // Poll metrics every 5 seconds, progressive status every 2 seconds
    const metricsInterval = setInterval(fetchMetrics, 5000);
    const progressiveInterval = setInterval(fetchProgressiveStatus, 2000);
    
    return () => {
      clearInterval(metricsInterval);
      clearInterval(progressiveInterval);
    };
  }, []);

  // Canary countdown timer effect
  useEffect(() => {
    if (progState?.currentPhase !== 'canary' || !progState.phaseStartTime) return;
    
    const interval = setInterval(() => {
      const elapsed = Date.now() - (progState.phaseStartTime || 0);
      const total = progState.canaryDurationMs;
      const remaining = Math.max(0, Math.ceil((total - elapsed) / 1000));
      setCanarySecondsLeft(remaining);
      
      if (remaining === 0) {
        fetchProgressiveStatus();
        fetchMetrics();
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [progState]);

  const triggerProgressiveAction = async (action: 'deploy' | 'promote' | 'rollback' | 'simulate-alert' | 'reset', reason?: string) => {
    try {
      const response = await fetch('/api/admin/trigger-progressive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, reason })
      });
      const data = await response.json();
      if (data.status === 'success') {
        fetchProgressiveStatus();
        fetchMetrics();
      } else {
        alert('Action failed: ' + data.message);
      }
    } catch (err: any) {
      alert('Error triggering action: ' + err.message);
    }
  };

  const triggerSampleTelemetry = (type: 'rage' | 'maigo' | 'fallback' | 'correction' | 'deepening') => {
    const mockEvent = {
      session_id: crypto.randomUUID(),
      user_id: 'simulated_user',
      current_route: '/admin',
      timestamp: new Date().toISOString(),
      revision_id: 'v2-experimental', // Push simulated friction to experimental branch
      is_rage_click: type === 'rage' ? 1 : 0,
      is_maigo: type === 'maigo' ? 1 : 0,
      schema_validation_error: type === 'fallback' ? 1 : 0,
      is_context_correction: type === 'correction' ? 1 : 0,
      is_context_deepening: type === 'deepening' ? 1 : 0,
      stay_duration_seconds: Math.random() * 120,
      regenerate_count: type === 'fallback' ? 2 : 0,
      raw_error_message: type === 'fallback' ? 'ZodError: Expected string, received number' : undefined
    };
    sendTelemetry(mockEvent);
    
    // Fetch metrics after a brief timeout
    setTimeout(() => {
      fetchMetrics();
      fetchProgressiveStatus();
    }, 500);
  };

  // Compute aggregated metrics
  const totalSessions = metrics.reduce((acc, m) => acc + m.total_sessions, 0);
  const totalRageClicks = metrics.reduce((acc, m) => acc + (m.rage_click_rate * m.total_sessions / 100), 0);
  const totalMaigos = metrics.reduce((acc, m) => acc + (m.maigo_rate * m.total_sessions / 100), 0);
  const totalFallbacks = metrics.reduce((acc, m) => acc + (m.smart_fallback_rate * m.total_sessions / 100), 0);
  const totalCorrections = metrics.reduce((acc, m) => acc + (m.context_correction_rate * m.total_sessions / 100), 0);
  const totalDeepenings = metrics.reduce((acc, m) => acc + (m.context_deepening_rate * m.total_sessions / 100), 0);

  // UX-driven SLI calculation
  const avgFrictionRate = totalSessions > 0
    ? ((totalRageClicks + totalMaigos + totalFallbacks + totalCorrections) * 100 / totalSessions)
    : 0;

  const trueSatisfaction = Math.max(0, 100 - avgFrictionRate);
  const satisfactionStatus = trueSatisfaction >= 90 ? 'green' : trueSatisfaction >= 80 ? 'yellow' : 'red';

  // Chart configuration
  const chartData = {
    labels: metrics.map(m => m.revision_id),
    datasets: [
      {
        label: 'Rage Click (%)',
        data: metrics.map(m => m.rage_click_rate),
        backgroundColor: 'rgba(239, 68, 68, 0.75)',
      },
      {
        label: 'Maigo Bouncing (%)',
        data: metrics.map(m => m.maigo_rate),
        backgroundColor: 'rgba(245, 158, 11, 0.75)',
      },
      {
        label: 'Format Crash (%)',
        data: metrics.map(m => m.smart_fallback_rate),
        backgroundColor: 'rgba(168, 85, 247, 0.75)',
      },
      {
        label: 'Context correction (%)',
        data: metrics.map(m => m.context_correction_rate),
        backgroundColor: 'rgba(236, 72, 153, 0.75)',
      },
      {
        label: 'Context Deepening (%)',
        data: metrics.map(m => m.context_deepening_rate),
        backgroundColor: 'rgba(16, 185, 129, 0.75)',
      }
    ]
  };

  return (
    <div className="container" style={{ marginTop: '24px', paddingBottom: '40px' }}>
      {/* Header Panel */}
      <div className="glass-panel" style={{ padding: '24px', marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '28px', letterSpacing: '-0.5px' }} className="gradient-text-cyan">UXOps Cockpit</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>
            Telemetry stream: <span className="status-dot green pulse" style={{ verticalAlign: 'middle', marginRight: '6px' }}></span>
            Connected to <strong>{dataSource === 'bigquery' ? 'GCP BigQuery Data Warehouse' : 'Express Local Buffer (Mocked)'}</strong>
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button className="btn btn-secondary" onClick={fetchMetrics}>
            <RefreshCw size={14} className={loading ? 'pulse' : ''} />
            Refresh Metrics
          </button>
        </div>
      </div>

      {error && (
        <div className="glass-panel" style={{ padding: '16px', background: 'rgba(239,68,68,0.1)', borderColor: 'rgba(239,68,68,0.3)', color: 'var(--accent-red)', marginBottom: '24px' }}>
          <AlertTriangle size={18} style={{ marginRight: '8px', verticalAlign: 'middle' }} />
          <strong>Error loading BigQuery metrics:</strong> {error}
        </div>
      )}

      {/* Metric Cards Row */}
      <div className="dashboard-grid">
        <div className="glass-panel metric-card green">
          <div className="metric-label">Infrastructure SLI/SLO</div>
          <div className="metric-value">99.98%</div>
          <div className="metric-trend text-secondary">
            <span className="status-dot green pulse" style={{ display: 'inline-block' }}></span>
            HTTP 200 OK (100% Target)
          </div>
        </div>

        <div className={`glass-panel metric-card ${satisfactionStatus}`}>
          <div className="metric-label">User Satisfaction SLI/SLO</div>
          <div className="metric-value">{trueSatisfaction.toFixed(1)}%</div>
          <div className="metric-trend" style={{ color: satisfactionStatus === 'green' ? 'var(--accent-green)' : satisfactionStatus === 'yellow' ? 'var(--accent-yellow)' : 'var(--accent-red)' }}>
            <span className={`status-dot ${satisfactionStatus} pulse`}></span>
            {trueSatisfaction >= 90 ? 'Healthy (SLO Met)' : 'Degraded (SLO Violated)'}
          </div>
        </div>

        <div className="glass-panel metric-card cyan">
          <div className="metric-label">Semantic Alignment</div>
          <div className="metric-value">
            {totalSessions > 0 ? (100 - (totalCorrections * 100 / totalSessions)).toFixed(1) : '100'}%
          </div>
          <div className="metric-trend text-secondary" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Smile size={14} className="text-green" /> 
            <span>Deepening: {totalSessions > 0 ? (totalDeepenings * 100 / totalSessions).toFixed(1) : '0'}%</span>
          </div>
        </div>
      </div>

      {/* PROGRESSIVE DELIVERY PANEL */}
      {progState && (
        <div className="glass-panel sensor-alert-pop" style={{ padding: '24px', marginBottom: '24px', borderLeft: '4px solid var(--accent-cyan)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Zap className="text-cyan pulse" size={20} />
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 700 }}>Progressive Delivery Defense Matrix (トラフィック全自動制御)</h2>
            </div>
            <div>
              <span className={`nav-link active`} style={{ 
                background: progState.currentPhase === 'none' ? 'rgba(255,255,255,0.05)' : progState.currentPhase === 'canary' ? 'var(--accent-yellow-glow)' : progState.currentPhase === 'ab-test' ? 'rgba(59,130,246,0.15)' : 'var(--accent-green-glow)',
                borderColor: progState.currentPhase === 'none' ? 'rgba(255,255,255,0.1)' : progState.currentPhase === 'canary' ? 'rgba(245,158,11,0.4)' : progState.currentPhase === 'ab-test' ? 'rgba(59,130,246,0.4)' : 'rgba(16,185,129,0.4)',
                color: progState.currentPhase === 'none' ? 'var(--text-secondary)' : progState.currentPhase === 'canary' ? 'var(--accent-yellow)' : progState.currentPhase === 'ab-test' ? '#3b82f6' : 'var(--accent-green)',
                fontWeight: 'bold', textTransform: 'uppercase', fontSize: '12px', padding: '4px 12px'
              }}>
                Current Phase: {progState.currentPhase === 'none' ? 'STABLE (100% v1)' : progState.currentPhase}
              </span>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '24px' }}>
            <div>
              {/* Traffic Split Visual Bar */}
              <div style={{ marginBottom: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', fontWeight: 'bold', marginBottom: '6px' }}>
                  <span className="text-cyan">v1 [Stable]: {progState.traffic.v1}%</span>
                  <span className="text-purple">v2-experimental [New]: {progState.traffic.v2}%</span>
                </div>
                <div style={{ height: '14px', background: 'rgba(0,0,0,0.4)', borderRadius: '7px', display: 'flex', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
                  <div style={{ width: `${progState.traffic.v1}%`, background: 'linear-gradient(90deg, #06b6d4, #3b82f6)', transition: 'width 0.8s ease' }}></div>
                  <div style={{ width: `${progState.traffic.v2}%`, background: 'linear-gradient(90deg, #ec4899, #a855f7)', transition: 'width 0.8s ease' }}></div>
                </div>
              </div>

              {/* Phase flow indicators */}
              <div style={{ display: 'flex', justifyContent: 'space-between', background: 'rgba(0,0,0,0.2)', padding: '12px', borderRadius: '10px', marginBottom: '20px', border: '1px solid rgba(255,255,255,0.03)' }}>
                <div style={{ textAlign: 'center', flex: 1, opacity: progState.currentPhase === 'none' ? 1 : 0.4 }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Phase 0</div>
                  <div style={{ fontWeight: 'bold', color: 'var(--text-primary)', fontSize: '13px' }}>v1 Active (100%)</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', color: 'var(--text-muted)' }}>➔</div>
                <div style={{ textAlign: 'center', flex: 1, opacity: progState.currentPhase === 'canary' ? 1 : 0.4 }}>
                  <div style={{ fontSize: '11px', color: 'var(--accent-yellow)' }}>Phase 1 {canarySecondsLeft !== null && `(${canarySecondsLeft}s)`}</div>
                  <div style={{ fontWeight: 'bold', color: progState.currentPhase === 'canary' ? 'var(--accent-yellow)' : 'var(--text-primary)', fontSize: '13px' }}>Canary (5%)</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', color: 'var(--text-muted)' }}>➔</div>
                <div style={{ textAlign: 'center', flex: 1, opacity: progState.currentPhase === 'ab-test' ? 1 : 0.4 }}>
                  <div style={{ fontSize: '11px', color: '#3b82f6' }}>Phase 2</div>
                  <div style={{ fontWeight: 'bold', color: progState.currentPhase === 'ab-test' ? '#3b82f6' : 'var(--text-primary)', fontSize: '13px' }}>A/B Test (50:50)</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', color: 'var(--text-muted)' }}>➔</div>
                <div style={{ textAlign: 'center', flex: 1, opacity: progState.currentPhase === 'blue-green' ? 1 : 0.4 }}>
                  <div style={{ fontSize: '11px', color: 'var(--accent-green)' }}>Phase 3</div>
                  <div style={{ fontWeight: 'bold', color: progState.currentPhase === 'blue-green' ? 'var(--accent-green)' : 'var(--text-primary)', fontSize: '13px' }}>Blue/Green (100%)</div>
                </div>
              </div>

              {/* Core Control Buttons */}
              <div style={{ display: 'flex', gap: '10px' }}>
                {progState.currentPhase === 'none' && (
                  <button className="btn btn-primary" onClick={() => triggerProgressiveAction('deploy')} style={{ background: 'linear-gradient(135deg, #06b6d4, #3b82f6)', color: '#000', fontWeight: 'bold' }}>
                    🚀 Deploy v2-experimental to Canary (5%)
                  </button>
                )}
                {progState.currentPhase === 'canary' && (
                  <>
                    <button className="btn btn-primary" onClick={() => triggerProgressiveAction('promote')} style={{ background: 'var(--accent-yellow)', color: '#000' }}>
                      ⏩ Force Promote to A/B Test (50:50)
                    </button>
                    <button className="btn btn-danger" onClick={() => triggerProgressiveAction('rollback', 'Manual emergency rollback from Canary')}>
                      🚨 Emergency Rollback (0% Traffic)
                    </button>
                  </>
                )}
                {progState.currentPhase === 'ab-test' && (
                  <>
                    <button className="btn btn-primary" onClick={() => triggerProgressiveAction('promote')} style={{ background: '#3b82f6', color: '#fff' }}>
                      🏆 Promote to Blue/Green (100% v2)
                    </button>
                    <button className="btn btn-danger" onClick={() => triggerProgressiveAction('rollback', 'Manual emergency rollback from A/B Test')}>
                      🚨 Emergency Rollback (v1: 100%)
                    </button>
                  </>
                )}
                {progState.currentPhase === 'blue-green' && (
                  <>
                    <button className="btn btn-danger" onClick={() => triggerProgressiveAction('rollback', 'Manual emergency rollback from Blue/Green 100%')} style={{ width: '100%' }}>
                      🚨 Emergency Rollback to v1 (Active Standby)
                    </button>
                  </>
                )}
                {progState.currentPhase !== 'none' && (
                  <button className="btn btn-secondary" onClick={() => triggerProgressiveAction('reset')}>
                    Reset
                  </button>
                )}
              </div>
            </div>

            {/* SRE Progressive History Log Console */}
            <div style={{ borderLeft: '1px solid var(--border-color)', paddingLeft: '20px', display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 'bold', textTransform: 'uppercase', marginBottom: '8px' }}>
                SRE Automated Control Log
              </div>
              <div style={{ 
                flex: 1, 
                background: 'rgba(0,0,0,0.3)', 
                borderRadius: '8px', 
                border: '1px solid rgba(255,255,255,0.03)', 
                padding: '10px', 
                fontSize: '11px', 
                fontFamily: 'var(--font-mono)', 
                overflowY: 'auto',
                maxHeight: '160px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px'
              }}>
                {progState.history.map((log, idx) => (
                  <div key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.02)', paddingBottom: '4px' }}>
                    <div style={{ color: 'var(--text-muted)' }}>{new Date(log.timestamp).toLocaleTimeString()}</div>
                    <div style={{ fontWeight: 'bold', color: log.event.includes('🚨') ? 'var(--accent-red)' : log.event.includes('🟡') ? 'var(--accent-yellow)' : log.event.includes('🟢') ? 'var(--accent-green)' : 'var(--text-primary)' }}>
                      {log.event}
                    </div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '10px', marginTop: '2px', lineHeight: 1.3 }}>{log.message}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Chart Section & Simulator Panel */}
      <div className="dashboard-details-row">
        <div className="glass-panel" style={{ padding: '24px' }}>
          <h2 style={{ fontSize: '18px', marginBottom: '20px' }}>UX & Semantic Signals by Revision</h2>
          <div style={{ height: '320px', position: 'relative' }}>
            {metrics.length > 0 ? (
              <Bar 
                data={chartData} 
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  scales: {
                    x: {
                      grid: { color: 'rgba(255, 255, 255, 0.05)' },
                      ticks: { color: 'rgba(255, 255, 255, 0.6)' }
                    },
                    y: {
                      grid: { color: 'rgba(255, 255, 255, 0.05)' },
                      ticks: { color: 'rgba(255, 255, 255, 0.6)' },
                      title: { display: true, text: 'Signal Occurrence Rate (%)', color: 'rgba(255,255,255,0.6)' }
                    }
                  },
                  plugins: {
                    legend: {
                      labels: { color: 'rgba(255, 255, 255, 0.8)', font: { family: 'var(--font-sans)', weight: 'bold' } }
                    }
                  }
                }} 
              />
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
                No telemetry signals collected yet.
              </div>
            )}
          </div>
        </div>

        {/* Simulator Panel */}
        <div className="glass-panel" style={{ padding: '24px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ fontSize: '18px', marginBottom: '8px' }}>Friction Generator</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '13px', lineHeight: 1.4 }}>
              Instantly push mock telemetry events to simulate different physical and semantic user stresses under the <code>v2-experimental</code> revision.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '16px' }}>
              <button className="btn btn-secondary" onClick={() => triggerSampleTelemetry('rage')} style={{ borderLeft: '4px solid var(--accent-red)', padding: '8px 12px' }}>
                💥 Simulate Rage Click
              </button>
              <button className="btn btn-secondary" onClick={() => triggerSampleTelemetry('maigo')} style={{ borderLeft: '4px solid var(--accent-yellow)', padding: '8px 12px' }}>
                🧭 Simulate Router Bouncing
              </button>
              <button className="btn btn-secondary" onClick={() => triggerSampleTelemetry('fallback')} style={{ borderLeft: '4px solid var(--accent-purple)', padding: '8px 12px' }}>
                ⚡ Simulate Schema Crash
              </button>
              <button className="btn btn-secondary" onClick={() => triggerSampleTelemetry('correction')} style={{ borderLeft: '4px solid #ec4899', padding: '8px 12px' }}>
                <Frown size={14} style={{ marginRight: '6px', verticalAlign: 'middle', color: '#ec4899' }} />
                Simulate Semantic Correction
              </button>
              <button className="btn btn-secondary" onClick={() => triggerSampleTelemetry('deepening')} style={{ borderLeft: '4px solid #10b981', padding: '8px 12px' }}>
                <Smile size={14} style={{ marginRight: '6px', verticalAlign: 'middle', color: '#10b981' }} />
                Simulate Semantic Deepening
              </button>
            </div>
            
            {progState && progState.currentPhase === 'blue-green' && (
              <div style={{ marginTop: '12px' }}>
                <button className="btn btn-danger" onClick={() => triggerProgressiveAction('simulate-alert')} style={{ width: '100%', padding: '8px 12px', fontSize: '13px' }}>
                  🚨 Simulate High Burn Rate Alert
                </button>
              </div>
            )}
          </div>
          <div style={{ borderTop: '1px solid var(--border-color)', marginTop: '16px', paddingTop: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>
              <Zap size={12} className="text-cyan" />
              <span>Real-time polling runs every 2s.</span>
            </div>
          </div>
        </div>
      </div>

      {/* Details Table */}
      <div className="glass-panel" style={{ padding: '24px', overflowX: 'auto' }}>
        <h2 style={{ fontSize: '18px', marginBottom: '16px' }}>Revision Performance Report</h2>
        <table className="logs-table">
          <thead>
            <tr>
              <th>App Revision</th>
              <th>Total Sessions</th>
              <th>Rage Clicks (%)</th>
              <th>Maigo Rate (%)</th>
              <th>Validation Error (%)</th>
              <th>Semantic Correction (%)</th>
              <th>Semantic Deepening (%)</th>
              <th>Avg Stay (s)</th>
              <th>Total Regenerate Press</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((row) => (
              <tr key={row.revision_id}>
                <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--accent-cyan)' }}>{row.revision_id}</td>
                <td>{row.total_sessions}</td>
                <td style={{ color: row.rage_click_rate > 5 ? 'var(--accent-red)' : 'var(--text-primary)' }}>{row.rage_click_rate}%</td>
                <td style={{ color: row.maigo_rate > 5 ? 'var(--accent-yellow)' : 'var(--text-primary)' }}>{row.maigo_rate}%</td>
                <td style={{ color: row.smart_fallback_rate > 5 ? 'var(--accent-purple)' : 'var(--text-primary)' }}>{row.smart_fallback_rate}%</td>
                <td style={{ color: row.context_correction_rate > 10 ? '#ec4899' : 'var(--text-primary)' }}>{row.context_correction_rate}%</td>
                <td style={{ color: 'var(--accent-green)' }}>{row.context_deepening_rate}%</td>
                <td>{row.avg_stay_duration}s</td>
                <td>{row.total_regenerate_press}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AppInner() {
  const sessionId = useRef(crypto.randomUUID()).current;
  const location = useLocation();

  // Initialize sensors globally
  useRageClick({ sessionId, currentRoute: location.pathname });
  useMaigo({ sessionId });

  return (
    <>
      <Navigation />
      <Routes>
        <Route path="/" element={<ChatPage sessionId={sessionId} />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/admin" element={<AdminPage />} />
      </Routes>
    </>
  );
}

function App() {
  return (
    <Router>
      <AppInner />
    </Router>
  );
}

export default App;
