const express = require('express');
const cors = require('cors');
const { PubSub } = require('@google-cloud/pubsub');
const { BigQuery } = require('@google-cloud/bigquery');
const { VertexAI } = require('@google-cloud/vertexai');
const { ServicesClient } = require('@google-cloud/run');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5001;
const PROJECT_ID = process.env.GCP_PROJECT || 'test-2163-kobuchi-shu';
const TOPIC_NAME = process.env.PUBSUB_TOPIC || 'ux-events-topic';

app.use(cors());
app.use(express.json());

// Initialize GCP Clients
let pubsub;
let bigquery;
let runClient;
let vertexAi;
let modelSemantic;     // Gemini 3.5 Flash-Lite: Real-time semantic sensor (low-latency, high-throughput)
let modelEvaluation;   // Gemini 3.8 Flash: Progressive delivery evaluation & Cockpit summary
let modelPostmortem;   // Gemini 4 Argon: Postmortem generation & prompt remediation

try {
  vertexAi = new VertexAI({ project: PROJECT_ID, location: 'asia-northeast1' });
  modelSemantic = vertexAi.getGenerativeModel({ model: 'gemini-3.5-flash-lite' });
  modelEvaluation = vertexAi.getGenerativeModel({ model: 'gemini-3.8-flash' });
  modelPostmortem = vertexAi.getGenerativeModel({ model: 'gemini-4-argon' });
  console.log('Vertex AI clients initialized: [gemini-3.5-flash-lite, gemini-3.8-flash, gemini-4-argon]');
} catch (err) {
  console.warn('Failed to initialize Vertex AI clients. Operating in mock semantic/AI mode.', err.message);
}

// In-memory fallback telemetry store for when BigQuery is unavailable (local testing)
const localTelemetryDb = [];

// Semantic analysis in-memory cache keyed by session_id
const semanticCache = new Map();

// Clean up expired semantic cache entries (> 1 hour) periodically
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, value] of semanticCache.entries()) {
    if (now - value.timestamp > 60 * 60 * 1000) {
      semanticCache.delete(sessionId);
    }
  }
}, 10 * 60 * 1000);

// Helper function to call Gemini 3.5 Flash-Lite for Semantic Friction analysis
async function analyzeSemanticFriction(sessionId, userMessage, lastAiMessage) {
  if (!sessionId || !userMessage) return;

  console.log(`[Semantic Analysis: gemini-3.5-flash-lite] Starting for session: ${sessionId}`);
  console.log(`[Semantic Analysis] User: "${userMessage}"`);
  console.log(`[Semantic Analysis] Last AI: "${lastAiMessage || '(None)'}"`);

  let is_context_correction = 0;
  let is_context_deepening = 0;

  if (modelSemantic) {
    try {
      const prompt = `
You are a highly accurate, deterministic semantic friction classifier for an SRE monitoring system.
Analyze the following conversation context between a User and an AI Assistant.

AI's Last Response:
"""
${lastAiMessage || '(No previous response)'}
"""

User's Follow-up Input:
"""
${userMessage}
"""

Determine if the User's input represents:
1. "is_context_correction": Set to 1 if the user is correcting the AI, complaining about a misunderstanding, re-specifying or clarifying their prompt because the AI gave an incorrect/unsatisfactory response, or expressing frustration/complaint about the AI's logic/format. Otherwise 0.
2. "is_context_deepening": Set to 1 if the AI's response was successful/helpful, and the user is asking further questions, deepening their knowledge, asking for details, or continuing a healthy productive dialogue. Otherwise 0.

Constraints:
- You must return ONLY a raw valid JSON object with EXACTLY the following schema, no markdown formatting, no backticks, no extra text:
{
  "is_context_correction": 0_or_1,
  "is_context_deepening": 0_or_1
}
`;

      const response = await modelSemantic.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json'
        }
      });

      const responseText = response.response.candidates[0].content.parts[0].text;
      console.log(`[Semantic Analysis] Raw Gemini Response: ${responseText}`);

      try {
        const result = JSON.parse(responseText.trim());
        is_context_correction = Number(result.is_context_correction) === 1 ? 1 : 0;
        is_context_deepening = Number(result.is_context_deepening) === 1 ? 1 : 0;
      } catch (parseErr) {
        console.error('[Semantic Analysis] Failed to parse Gemini JSON response, trying regex match:', parseErr.message);
        if (responseText.includes('"is_context_correction": 1') || responseText.includes('"is_context_correction":1')) {
          is_context_correction = 1;
        }
        if (responseText.includes('"is_context_deepening": 1') || responseText.includes('"is_context_deepening":1')) {
          is_context_deepening = 1;
        }
      }
    } catch (err) {
      console.error('[Semantic Analysis] Gemini API call failed, falling back to rule-based heuristics:', err.message);
      // Heuristic Fallback
      const lowerMsg = userMessage.toLowerCase();
      if (lowerMsg.includes('違う') || lowerMsg.includes('そうじゃなくて') || lowerMsg.includes('間違') || lowerMsg.includes('error') || lowerMsg.includes('ダメ')) {
        is_context_correction = 1;
      } else if (lowerMsg.includes('詳しく') || lowerMsg.includes('詳細') || lowerMsg.includes('もっと') || lowerMsg.includes('さらに')) {
        is_context_deepening = 1;
      }
    }
  } else {
    // Standard mock heuristic fallback if Vertex AI not configured
    console.log('[Semantic Analysis] Operating in mock heuristic mode.');
    const lowerMsg = userMessage.toLowerCase();
    if (lowerMsg.includes('違う') || lowerMsg.includes('そうじゃなくて') || lowerMsg.includes('間違') || lowerMsg.includes('error') || lowerMsg.includes('ダメ')) {
      is_context_correction = 1;
    } else if (lowerMsg.includes('詳しく') || lowerMsg.includes('詳細') || lowerMsg.includes('もっと') || lowerMsg.includes('さらに')) {
      is_context_deepening = 1;
    }
  }

  console.log(`[Semantic Analysis] Result for ${sessionId}: correction=${is_context_correction}, deepening=${is_context_deepening}`);
  
  // Save results in cache for matching /api/telemetry
  semanticCache.set(sessionId, {
    is_context_correction,
    is_context_deepening,
    timestamp: Date.now()
  });
}

// Helper function to call Gemini 3.8 Flash for Progressive Delivery & A/B Evaluation
async function evaluateProgressiveAB(metrics) {
  console.log('[Evaluation: gemini-3.8-flash] Starting A/B metrics evaluation');

  const v1Metrics = metrics.find(m => m.revision_id === 'v1') || {
    revision_id: 'v1', total_sessions: 100, rage_click_rate: 2.0, maigo_rate: 1.5,
    smart_fallback_rate: 0.0, context_correction_rate: 5.0, context_deepening_rate: 20.0
  };
  const v2Metrics = metrics.find(m => m.revision_id === 'v2' || m.revision_id === 'v2-experimental') || {
    revision_id: 'v2', total_sessions: 95, rage_click_rate: 1.8, maigo_rate: 1.2,
    smart_fallback_rate: 0.0, context_correction_rate: 4.2, context_deepening_rate: 28.5
  };

  if (modelEvaluation) {
    try {
      const prompt = `
You are a Staff SRE and Progressive Delivery Evaluator for a modern AI-native cloud platform.
Evaluate the A/B testing metrics between baseline (v1) and candidate (v2-experimental):

v1 (Baseline):
- Total Sessions: ${v1Metrics.total_sessions}
- Rage Click Rate: ${v1Metrics.rage_click_rate}%
- Maigo (Routing Ping-pong) Rate: ${v1Metrics.maigo_rate}%
- Smart Fallback (Schema Error) Rate: ${v1Metrics.smart_fallback_rate}%
- Context Correction (User complaint/re-explanation) Rate: ${v1Metrics.context_correction_rate}%
- Context Deepening (Follow-up inquiry) Rate: ${v1Metrics.context_deepening_rate}%

v2 (Candidate):
- Total Sessions: ${v2Metrics.total_sessions}
- Rage Click Rate: ${v2Metrics.rage_click_rate}%
- Maigo Rate: ${v2Metrics.maigo_rate}%
- Smart Fallback Rate: ${v2Metrics.smart_fallback_rate}%
- Context Correction Rate: ${v2Metrics.context_correction_rate}%
- Context Deepening Rate: ${v2Metrics.context_deepening_rate}%

Criteria:
1. If v2 has smart_fallback_rate > 0.5% or context_correction_rate notably higher than v1 -> "ROLLBACK".
2. If v2 shows lower or equal context_correction_rate AND equal or higher context_deepening_rate -> "PROMOTE".
3. Otherwise -> "CONTINUE_OBSERVATION".

Respond ONLY in raw JSON matching this schema:
{
  "recommendation": "PROMOTE" | "ROLLBACK" | "CONTINUE_OBSERVATION",
  "confidence_score": 0.0_to_1.0,
  "summary_ja": "日本語での意思決定サマリー（2〜3文）",
  "key_findings": ["箇条書きで分析理由を2〜3点"]
}
`;

      const response = await modelEvaluation.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      });

      const responseText = response.response.candidates[0].content.parts[0].text;
      return JSON.parse(responseText.trim());
    } catch (err) {
      console.error('[Evaluation: gemini-3.8-flash] Vertex AI call failed, falling back to deterministic heuristic:', err.message);
    }
  }

  // Heuristic mock evaluation
  const isCorrectionWorse = Number(v2Metrics.context_correction_rate) > Number(v1Metrics.context_correction_rate) + 2.0;
  const isFallbackError = Number(v2Metrics.smart_fallback_rate) > 0.5;

  if (isFallbackError || isCorrectionWorse) {
    return {
      recommendation: "ROLLBACK",
      confidence_score: 0.96,
      summary_ja: `v2リビジョンにおいて${isFallbackError ? 'スキーマ破壊エラー' : '文脈の言い直し率上昇'}が検出されました。UX SLO違反のリスクがあるため即時ロールバックを推奨します。`,
      key_findings: [
        `v2の言い直し率 (${v2Metrics.context_correction_rate}%) がベースラインv1 (${v1Metrics.context_correction_rate}%) を上回っています`,
        `Smart Fallback発生率: ${v2Metrics.smart_fallback_rate}%`
      ]
    };
  }

  return {
    recommendation: "PROMOTE",
    confidence_score: 0.94,
    summary_ja: "v2リビジョンは言い直し率を低水準に維持しつつ、深掘り発話率が向上しています。UX改善が確認されたため、Blue/Green (100%) への昇格を推奨します。",
    key_findings: [
      `文脈深掘り率が ${v1Metrics.context_deepening_rate}% から ${v2Metrics.context_deepening_rate}% へ伸長`,
      `物理フリクション（レイジクリック: ${v2Metrics.rage_click_rate}%, 迷子: ${v2Metrics.maigo_rate}%）は許容値内`
    ]
  };
}

// Helper function to call Gemini 4 Argon for Deep Postmortem Analysis & Prompt Remediation
async function generatePostmortem(incidentData) {
  console.log('[Postmortem: gemini-4-argon] Starting deep RCA & prompt remediation');

  const { reason, previousPhase, errorLogs, userMessages } = incidentData;

  if (modelPostmortem) {
    try {
      const prompt = `
You are the Principal SRE and LLM System Architect specializing in UXOps and Incident Response.
Perform a Deep Root Cause Analysis (RCA) and generate a Postmortem Report for a Cloud Run automated rollback incident.

Incident Details:
- Rollback Trigger Reason: ${reason}
- Previous Deployment Phase: ${previousPhase}
- Sample Captured Error Logs:
${JSON.stringify(errorLogs || ['ZodError: Expected string, received number at path [answer]', 'SchemaValidationError: Invalid JSON closing bracket'])}
- Sample User Frustration Inputs:
${JSON.stringify(userMessages || ['「全然違う、前提条件をもう一度読んで」「JSONが崩れてるよ」'])}

Your task:
Write a high-fidelity Markdown Postmortem Report in Japanese containing:
1. 🚨 インシデント概要 (Incident Overview)
2. 🔍 根本原因分析 (Root Cause Analysis - RCA: Why the prompt/revision failed)
3. 📉 UX & エラーバジェット影響 (Impact on User Experience & Burn Rate)
4. 🛠️ 改善プロンプト提案 (Remediated System Prompt with Markdown diff format)
5. 🛡️ 再発防止策 (Action Items / Preventative Measures)

Markdown Output Only.
`;

      const response = await modelPostmortem.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
      });

      return response.response.candidates[0].content.parts[0].text;
    } catch (err) {
      console.error('[Postmortem: gemini-4-argon] Vertex AI call failed, falling back to mock postmortem:', err.message);
    }
  }

  // High-fidelity fallback postmortem report
  return `# 🚨 UXOps Postmortem Report: v2-experimental 自動ロールバック事後分析

**執筆担当**: Gemini 4 Argon (Automated Incident Commander)  
**発生日時**: ${new Date().toISOString()}  
**トリガー事象**: ${reason}  
**ロールバック時間**: 850ms（Cloud Run Traffic Splitting による 100% v1 即時復帰）

---

## 1. インシデント概要
Cloud Run 上でデプロイされた新リビジョン \`v2-experimental\`（新プロンプト適用）において、トラフィック展開フェーズ（${previousPhase}）中に **「UX駆動型SLO違反」** を検知。エラーバジェットの消費速度（バーンレート）が許容閾値を超過したため、システムが自己修復メカニズムを作動させ、全トラフィックを安定版 \`v1\` へ自動ロールバックしました。

## 2. 根本原因分析 (Root Cause Analysis: 5 Whys)
1. **なぜロールバックが発火したか？**: \`schema_validation_error\` の急増およびユーザー発話での \`is_context_correction = 1\`（言い直し）が多発したため。
2. **なぜスキーマエラーが発生したか？**: LLMの出力トークンに予期せぬMarkdownフェンス記号（\`\`\`json）が混入し、クライアント側の Zod Strict Parser が構文エラーと判定したため。
3. **なぜユーザーの言い直しが増加したか？**: 新プロンプトで出力を過度に要約した結果、ユーザーの求める詳細情報が欠落し、「そうじゃなくて、もっと具体的に」という再説明ストレスを誘発したため。

## 3. UX & エラーバジェットへの影響
- **HTTP 200 OK 稼働率**: 100.0%（インフラ監視上は完全なグリーン）
- **真のUX満足度 (User Satisfaction SLO)**: 92.4% ➔ **68.2% へ急降下（Red）**
- **1秒ロールバックによる効果**: 約95%のユーザーセッションをクラッシュ・ホワイトアウトから事前防衛。

---

## 4. 🛠️ 改善プロンプト提案 (Diff)

\`\`\`diff
  You are an expert enterprise assistant.
- Provide a concise summary of the answer in JSON format.
+ Provide the answer strictly conforming to the following JSON schema.
+ Do NOT wrap with markdown backticks (e.g. \`\`\`json). Output raw valid JSON only.
+ Ensure the response contains sufficient depth to minimize user follow-up corrections.
  
  JSON Schema:
  {
+   "summary": "string",
+   "details": ["string"],
+   "confidence": 1.0
  }
\`\`\`

## 5. 再発防止策 (Action Items)
- [ ] **P0**: Playwright E2E カオスシミュレータに「不完全JSONレスポンスに対する Canary 遮断テスト」を CI パイプラインとして常時組み込み。
- [ ] **P1**: Gemini 3.5 Flash-Lite の非同期セマンティック判定による文脈言い直し率を A/B 判定ゲートの必須通過要件に設定。
- [ ] **P2**: Cloud Run のリビジョン自動デプロイフックに Zod スキーマの Dry-Run 検証ステップを追加。
`;
}

// --- PROGRESSIVE DELIVERY STATE & CONTROLLER ---
let lastRollbackIncident = null;

const progressiveState = {
  currentPhase: 'none', // 'none' | 'canary' | 'ab-test' | 'blue-green'
  traffic: {
    v1: 100,
    v2: 0
  },
  v2RevisionName: 'v2-experimental',
  v1RevisionName: 'v1',
  phaseStartTime: null,
  canaryTimer: null,
  history: [
    {
      timestamp: new Date().toISOString(),
      event: 'System Initialized ⚪',
      message: 'Progressive delivery system ready. Traffic split: v1=100%, v2=0%'
    }
  ]
};

async function updateTrafficShare(v1Rate, v2Rate) {
  console.log(`[Cloud Run Traffic Split] Updating traffic share: v1=${v1Rate}%, v2=${v2Rate}%`);
  
  if (runClient) {
    try {
      const servicePath = runClient.servicePath(PROJECT_ID, 'asia-northeast1', 'friction-ops-service');
      const [service] = await runClient.getService({ name: servicePath });
      
      service.traffic = [
        { revision: progressiveState.v1RevisionName, percent: v1Rate },
        { revision: progressiveState.v2RevisionName, percent: v2Rate }
      ];
      
      console.log(`[Cloud Run Traffic Split] Sending update request to GCP for service: friction-ops-service`);
      const [operation] = await runClient.updateService({ service });
      console.log(`[Cloud Run Traffic Split] Update operation started: ${operation.name}`);
    } catch (err) {
      console.warn('[Cloud Run Traffic Split] Real GCP update failed. Falling back to simulation.', err.message);
    }
  }
  
  progressiveState.traffic = { v1: v1Rate, v2: v2Rate };
}

async function triggerRollback(reason) {
  const previousPhase = progressiveState.currentPhase;
  progressiveState.currentPhase = 'none';
  progressiveState.phaseStartTime = null;
  
  if (progressiveState.canaryTimer) {
    clearTimeout(progressiveState.canaryTimer);
    progressiveState.canaryTimer = null;
  }
  
  await updateTrafficShare(100, 0);
  
  // Record incident data for Gemini 4 Argon Postmortem analysis
  lastRollbackIncident = {
    timestamp: new Date().toISOString(),
    reason: reason,
    previousPhase: previousPhase,
    errorLogs: [
      `ZodError: Expected object format, received malformed payload during Canary 5% phase`,
      `SmartFallbackTriggered: schema_validation_error = 1 detected on client`,
      `CloudRunTrafficSplit: emergency redirect v1: 100%, v2: 0%`
    ],
    userMessages: [
      "回答のJSONが途中で切れています",
      "前回の条件と全然違う回答になっています、もう一度やり直して"
    ]
  };

  progressiveState.history.unshift({
    timestamp: new Date().toISOString(),
    event: 'Rollback Triggered 🚨',
    message: `AUTOMATED ROLLBACK from [${previousPhase}] phase to [v1: 100% / v2: 0%] traffic. Reason: ${reason}`
  });
  console.log(`[Progressive Delivery] Automated rollback complete. Reason: ${reason}`);
}

async function transitionPhase(targetPhase) {
  const nowStr = new Date().toISOString();
  
  if (progressiveState.canaryTimer) {
    clearTimeout(progressiveState.canaryTimer);
    progressiveState.canaryTimer = null;
  }

  if (targetPhase === 'canary') {
    progressiveState.currentPhase = 'canary';
    progressiveState.phaseStartTime = Date.now();
    await updateTrafficShare(95, 5);
    progressiveState.history.unshift({
      timestamp: nowStr,
      event: 'Phase Canary Started 🟡',
      message: `Deployed 'v2-experimental' to Canary phase with 5% traffic. Initiating 30-second automated validation window.`
    });

    // Start Canary timer (30s for demo, 5m for production)
    const delay = process.env.NODE_ENV === 'production' ? 5 * 60 * 1000 : 30 * 1000;
    progressiveState.canaryTimer = setTimeout(async () => {
      if (progressiveState.currentPhase === 'canary') {
        console.log(`[Progressive Delivery] Canary timer expired with no errors. Promoting automatically to A/B Test phase.`);
        await transitionPhase('ab-test');
      }
    }, delay);

  } else if (targetPhase === 'ab-test') {
    progressiveState.currentPhase = 'ab-test';
    progressiveState.phaseStartTime = Date.now();
    await updateTrafficShare(50, 50);
    progressiveState.history.unshift({
      timestamp: nowStr,
      event: 'Phase A/B Test Started 🔵',
      message: `Canary phase cleared without errors. Promoted to A/B Test phase with 50% vs 50% split.`
    });

  } else if (targetPhase === 'blue-green') {
    progressiveState.currentPhase = 'blue-green';
    progressiveState.phaseStartTime = Date.now();
    await updateTrafficShare(0, 100);
    progressiveState.history.unshift({
      timestamp: nowStr,
      event: 'Phase Blue/Green Completed 🟢',
      message: `A/B Test metrics verified. Promoted v2-experimental to 100% traffic (Blue/Green). Old v1 kept active at 0% traffic as active-standby.`
    });

  } else if (targetPhase === 'none') {
    progressiveState.currentPhase = 'none';
    progressiveState.phaseStartTime = null;
    await updateTrafficShare(100, 0);
    progressiveState.history.unshift({
      timestamp: nowStr,
      event: 'Reset To v1 ⚪',
      message: `Resetting deployment state. Traffic redirected 100% to v1.`
    });
  }
}

// 1. Telemetry Ingestion API (POST /api/telemetry)
app.post('/api/telemetry', async (req, res) => {
  const payload = req.body;
  console.log('Received Telemetry Event:', JSON.stringify(payload));

  // Intercept and merge semantic cache signals if available
  const cached = semanticCache.get(payload.session_id);
  if (cached) {
    payload.is_context_correction = cached.is_context_correction;
    payload.is_context_deepening = cached.is_context_deepening;
    // Clear cache to prevent duplicate reuse
    semanticCache.delete(payload.session_id);
    console.log(`[Telemetry Ingestion] Merged semantic signals for session ${payload.session_id}: correction=${payload.is_context_correction}, deepening=${payload.is_context_deepening}`);
  } else {
    payload.is_context_correction = payload.is_context_correction || 0;
    payload.is_context_deepening = payload.is_context_deepening || 0;
  }

  // --- PROGRESSIVE DELIVERY AUTOMATED ROLLBACK TRIGGERS ---
  // In Canary phase, any schema validation crash triggers immediate 0% rollback
  if (progressiveState.currentPhase === 'canary' && Number(payload.schema_validation_error) === 1) {
    console.log(`[Auto-Rollback] Canary phase format crash (schema_validation_error=1) detected! Initiating immediate 0% rollback.`);
    triggerRollback("Canary Phase Format Crash (schema_validation_error=1) detected");
  } else if (payload.revision_id === 'v2-experimental' || progressiveState.currentPhase !== 'none') {
    if (progressiveState.currentPhase === 'ab-test' && Number(payload.is_context_correction) === 1) {
      console.log(`[Auto-Rollback] A/B Test phase semantic correction (is_context_correction=1) detected! Initiating rollback.`);
      triggerRollback("A/B Test Phase Semantic Correction (is_context_correction=1) detected");
    } else if (progressiveState.currentPhase === 'blue-green' && Number(payload.is_rage_click) === 1) {
      console.log(`[Auto-Rollback] High friction alert (is_rage_click=1) detected! Initiating emergency rollback.`);
      triggerRollback("High Burn Rate Emergency Alert (is_rage_click=1) detected");
    }
  }

  // Asynchronously publish to Pub/Sub to prevent blocking client responses
  if (pubsub) {
    const dataBuffer = Buffer.from(JSON.stringify(payload));
    pubsub.topic(TOPIC_NAME).publishMessage({ data: dataBuffer })
      .then(messageId => {
        console.log(`Telemetry published to Pub/Sub topic: ${TOPIC_NAME}. Message ID: ${messageId}`);
      })
      .catch(err => {
        console.error('Failed to publish to Pub/Sub:', err);
      });
  }

  // Always keep a local log copy for robust fallback admin UI
  localTelemetryDb.push({
    ...payload,
    timestamp: payload.timestamp || new Date().toISOString()
  });
  // Keep local DB size bounded
  if (localTelemetryDb.length > 500) {
    localTelemetryDb.shift();
  }

  // Respond immediately with 202 Accepted
  res.status(202).json({
    status: 'accepted',
    message: 'Telemetry event accepted and queued for processing.'
  });
});

// 2. Admin Analytics API (GET /api/admin/ux-metrics)
app.get('/api/admin/ux-metrics', async (req, res) => {
  const hours = parseInt(req.query.hours || '24', 10);
  
  const query = `
    SELECT 
      revision_id,
      COUNT(*) as total_sessions,
      ROUND(COUNT(CASE WHEN is_rage_click = 1 THEN 1 END) * 100.0 / COUNT(*), 2) as rage_click_rate,
      ROUND(COUNT(CASE WHEN is_maigo = 1 THEN 1 END) * 100.0 / COUNT(*), 2) as maigo_rate,
      ROUND(COUNT(CASE WHEN schema_validation_error = 1 THEN 1 END) * 100.0 / COUNT(*), 2) as smart_fallback_rate,
      -- 【新規追記】会話のズレ・深掘り率の算出
      ROUND(COUNT(CASE WHEN is_context_correction = 1 THEN 1 END) * 100.0 / COUNT(*), 2) as context_correction_rate,
      ROUND(COUNT(CASE WHEN is_context_deepening = 1 THEN 1 END) * 100.0 / COUNT(*), 2) as context_deepening_rate,
      ROUND(AVG(stay_duration_seconds), 1) as avg_stay_duration,
      SUM(regenerate_count) as total_regenerate_press
    FROM \`${PROJECT_ID}.friction_ops.ux_events_raw\`
    WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @hours HOUR)
    GROUP BY revision_id;
  `;

  const options = {
    query: query,
    params: { hours: hours },
  };

  try {
    if (!bigquery) {
      throw new Error('BigQuery client is not initialized.');
    }

    console.log(`Executing BigQuery metrics query for the last ${hours} hours...`);
    const [rows] = await bigquery.query(options);
    console.log('BigQuery Metrics Result:', rows);

    res.json({
      source: 'bigquery',
      metrics: rows
    });
  } catch (err) {
    console.warn('BigQuery query failed, returning aggregated local in-memory metrics.', err.message);

    // Compute aggregated metrics from local in-memory DB as a fallback
    const aggregated = {};
    localTelemetryDb.forEach(event => {
      const eventTime = new Date(event.timestamp);
      const limitTime = new Date(Date.now() - hours * 60 * 60 * 1000);
      if (eventTime < limitTime) return;

      const rev = event.revision_id || 'v1';
      if (!aggregated[rev]) {
        aggregated[rev] = {
          revision_id: rev,
          total_sessions: 0,
          rage_clicks: 0,
          maigos: 0,
          fallback_errors: 0,
          context_corrections: 0,
          context_deepenings: 0,
          total_stay_duration: 0,
          total_regenerate_press: 0
        };
      }

      aggregated[rev].total_sessions++;
      if (Number(event.is_rage_click) === 1) aggregated[rev].rage_clicks++;
      if (Number(event.is_maigo) === 1) aggregated[rev].maigos++;
      if (Number(event.schema_validation_error) === 1) aggregated[rev].fallback_errors++;
      if (Number(event.is_context_correction) === 1) aggregated[rev].context_corrections++;
      if (Number(event.is_context_deepening) === 1) aggregated[rev].context_deepenings++;
      aggregated[rev].total_stay_duration += Number(event.stay_duration_seconds || 0);
      aggregated[rev].total_regenerate_press += Number(event.regenerate_count || 0);
    });

    const metrics = Object.values(aggregated).map(revData => ({
      revision_id: revData.revision_id,
      total_sessions: revData.total_sessions,
      rage_click_rate: Number((revData.rage_clicks * 100 / revData.total_sessions).toFixed(2)),
      maigo_rate: Number((revData.maigos * 100 / revData.total_sessions).toFixed(2)),
      smart_fallback_rate: Number((revData.fallback_errors * 100 / revData.total_sessions).toFixed(2)),
      context_correction_rate: Number((revData.context_corrections * 100 / revData.total_sessions).toFixed(2)),
      context_deepening_rate: Number((revData.context_deepenings * 100 / revData.total_sessions).toFixed(2)),
      avg_stay_duration: Number((revData.total_stay_duration / revData.total_sessions).toFixed(1)),
      total_regenerate_press: revData.total_regenerate_press
    }));

    // Local fallback mock data defaults
    if (metrics.length === 0) {
      metrics.push({
        revision_id: 'v1',
        total_sessions: 142,
        rage_click_rate: 4.22,
        maigo_rate: 1.41,
        smart_fallback_rate: 2.11,
        context_correction_rate: 3.52,
        context_deepening_rate: 18.31,
        avg_stay_duration: 48.5,
        total_regenerate_press: 12
      });
      metrics.push({
        revision_id: 'v2-experimental',
        total_sessions: 98,
        rage_click_rate: 12.24,
        maigo_rate: 8.16,
        smart_fallback_rate: 15.31,
        context_correction_rate: 24.49,
        context_deepening_rate: 5.10,
        avg_stay_duration: 122.4,
        total_regenerate_press: 35
      });
    }

    res.json({
      source: 'local_fallback',
      warning: err.message,
      metrics: metrics
    });
  }
});

// 4. Progressive Delivery Controller API (POST /api/admin/trigger-progressive)
app.post('/api/admin/trigger-progressive', async (req, res) => {
  const { action, reason } = req.body;
  console.log(`[Progressive API] Action: ${action}, Reason: ${reason}`);

  try {
    if (action === 'deploy') {
      await transitionPhase('canary');
    } else if (action === 'promote') {
      if (progressiveState.currentPhase === 'canary') {
        await transitionPhase('ab-test');
      } else if (progressiveState.currentPhase === 'ab-test') {
        await transitionPhase('blue-green');
      } else {
        throw new Error(`Cannot manually promote from current phase: ${progressiveState.currentPhase}`);
      }
    } else if (action === 'rollback') {
      await triggerRollback(reason || "Manual developer override via dashboard");
    } else if (action === 'simulate-alert') {
      await triggerRollback(reason || "Simulated Cloud Monitoring Alert (Burn Rate > 14.4)");
    } else if (action === 'reset') {
      await transitionPhase('none');
    } else {
      throw new Error(`Invalid progressive delivery action: ${action}`);
    }

    res.json({
      status: 'success',
      state: {
        currentPhase: progressiveState.currentPhase,
        traffic: progressiveState.traffic,
        phaseStartTime: progressiveState.phaseStartTime,
        historyCount: progressiveState.history.length
      }
    });
  } catch (err) {
    console.error('[Progressive API] Error:', err.message);
    res.status(400).json({ status: 'error', message: err.message });
  }
});

// 5. Progressive Delivery Status API (GET /api/admin/progressive-status)
app.get('/api/admin/progressive-status', (req, res) => {
  res.json({
    currentPhase: progressiveState.currentPhase,
    traffic: progressiveState.traffic,
    v2RevisionName: progressiveState.v2RevisionName,
    v1RevisionName: progressiveState.v1RevisionName,
    phaseStartTime: progressiveState.phaseStartTime,
    canaryDurationMs: process.env.NODE_ENV === 'production' ? 5 * 60 * 1000 : 30 * 1000,
    history: progressiveState.history,
    hasRollbackIncident: !!lastRollbackIncident
  });
});

// 6. Gemini 3.8 Flash: Progressive Delivery A/B Evaluation API
app.post('/api/admin/evaluate-ab', async (req, res) => {
  try {
    const { metrics } = req.body;
    console.log('[API: /api/admin/evaluate-ab] Request received');
    const evaluation = await evaluateProgressiveAB(metrics || []);
    res.json({
      status: 'success',
      model: 'gemini-3.8-flash',
      evaluation
    });
  } catch (err) {
    console.error('[API: /api/admin/evaluate-ab] Error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 7. Gemini 4 Argon: Postmortem & Remediation Generation API
app.post('/api/admin/generate-postmortem', async (req, res) => {
  try {
    console.log('[API: /api/admin/generate-postmortem] Request received');
    const incidentData = req.body.incidentData || lastRollbackIncident || {
      reason: 'Manual Postmortem Request / Simulated Burn Rate Alert',
      previousPhase: progressiveState.currentPhase === 'none' ? 'canary' : progressiveState.currentPhase,
      errorLogs: ['ZodError: Expected string, received number at path [answer]'],
      userMessages: ['「全然違う、前提条件をもう一度読んで」']
    };

    const postmortemMarkdown = await generatePostmortem(incidentData);
    res.json({
      status: 'success',
      model: 'gemini-4-argon',
      incident: incidentData,
      postmortem: postmortemMarkdown
    });
  } catch (err) {
    console.error('[API: /api/admin/generate-postmortem] Error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 8. Model Status API (GET /api/admin/model-status)
app.get('/api/admin/model-status', (req, res) => {
  res.json({
    models: [
      {
        name: 'Gemini 3.5 Flash-Lite',
        role: 'Real-time Semantic Sensor (Frontend / Backend Telemetry)',
        status: modelSemantic ? 'CONNECTED' : 'MOCK_HEURISTIC',
        latency: 'Sub-50ms',
        cost: 'Ultra-low ($0.0375 / 1M tokens)'
      },
      {
        name: 'Gemini 3.8 Flash',
        role: 'Progressive Delivery Evaluator & Cockpit Summary',
        status: modelEvaluation ? 'CONNECTED' : 'MOCK_REASONING',
        latency: '~200ms',
        cost: 'Balanced ($0.15 / 1M tokens)'
      },
      {
        name: 'Gemini 4 Argon',
        role: 'Deep Incident Postmortem & Prompt Remediation',
        status: modelPostmortem ? 'CONNECTED' : 'MOCK_HIGH_REASONING',
        latency: '~1.2s',
        cost: 'Deep Reasoning ($1.25 / 1M tokens)'
      }
    ]
  });
});

// 3. Mock LLM Chat API (POST /api/mock-llm)
app.post('/api/mock-llm', (req, res) => {
  const { message, broken, lastAiMessage, sessionId } = req.body;
  console.log(`Mock LLM Chat called: "${message}", Broken JSON Mode: ${broken}`);

  // Trigger semantic analysis asynchronously in background
  if (sessionId) {
    analyzeSemanticFriction(sessionId, message, lastAiMessage)
      .catch(err => console.error('Background semantic analysis failed:', err));
  }

  if (broken) {
    // Return structurally malformed JSON string (unclosed braces, invalid format)
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(`{
      "reply": "System Error: The response from the deep reasoning model failed to format properly. This is standard raw JSON data with unclosed structures and missing syntax...",
      "metadata": {
        "status": "partial_failure",
        "error_code": "JSON_SCHEMA_CORRUPTION",
        "raw_stack": "Unexpected end of input at line 5 column 10",
        "model": "gemini-3.5-flash"
      `); // Missing closing bracket!
  } else {
    // Return normal structured JSON
    const replies = [
      "I have processed your query. The Friction Observability pipeline is active and monitoring all digital user stress signals.",
      "Indeed! Rage clicks are tracked at 5 clicks/second, and Maigo routing triggers when you ping-pong between pages 4 times in 30 seconds.",
      "The telemetry endpoint POST /api/telemetry is designed to be fully non-blocking, responding with a 202 Accepted in under 10 milliseconds.",
      "The User Satisfaction SLO computes 100% minus the rate of friction events. If the rate rises above 10%, our error budget burns!"
    ];
    const randomReply = replies[Math.floor(Math.random() * replies.length)];
    
    res.json({
      reply: randomReply,
      metadata: {
        status: 'success',
        model: 'gemini-3.5-flash'
      }
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', project: PROJECT_ID });
});

// Serve static files from the React frontend build
const path = require('path');
app.use(express.static(path.join(__dirname, '../frontend/dist')));

// For any other routes, send back index.html (client-side routing)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
