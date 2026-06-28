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
let vertexAi;
let generativeModel;
let runClient;

try {
  pubsub = new PubSub({ projectId: PROJECT_ID });
  bigquery = new BigQuery({ projectId: PROJECT_ID });
  console.log(`GCP clients initialized for project: ${PROJECT_ID}`);
} catch (err) {
  console.warn('Failed to initialize GCP clients. Operating in fallback/mock mode.', err.message);
}

try {
  runClient = new ServicesClient({ projectId: PROJECT_ID });
  console.log('Google Cloud Run ServicesClient initialized successfully.');
} catch (err) {
  console.warn('Failed to initialize Google Cloud Run ServicesClient. Operating in mock/simulation mode.', err.message);
}

try {
  // Initialize Vertex AI with the region suitable for Gemini
  vertexAi = new VertexAI({ project: PROJECT_ID, location: 'asia-northeast1' });
  generativeModel = vertexAi.getGenerativeModel({
    model: 'gemini-3.5-flash'
  });
  console.log('Vertex AI client initialized with model: gemini-3.5-flash');
} catch (err) {
  console.warn('Failed to initialize Vertex AI client. Operating in mock semantic mode.', err.message);
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

// Helper function to call Gemini Flash for Semantic Friction analysis
async function analyzeSemanticFriction(sessionId, userMessage, lastAiMessage) {
  if (!sessionId || !userMessage) return;

  console.log(`[Semantic Analysis] Starting for session: ${sessionId}`);
  console.log(`[Semantic Analysis] User: "${userMessage}"`);
  console.log(`[Semantic Analysis] Last AI: "${lastAiMessage || '(None)'}"`);

  let is_context_correction = 0;
  let is_context_deepening = 0;

  if (generativeModel) {
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

      const response = await generativeModel.generateContent({
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

// --- PROGRESSIVE DELIVERY STATE & CONTROLLER ---
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
  if (payload.revision_id === 'v2-experimental') {
    if (progressiveState.currentPhase === 'canary' && Number(payload.schema_validation_error) === 1) {
      console.log(`[Auto-Rollback] Canary phase format crash (schema_validation_error=1) detected! Initiating immediate 0% rollback.`);
      triggerRollback("Canary Phase Format Crash (schema_validation_error=1) detected on v2-experimental");
    } else if (progressiveState.currentPhase === 'ab-test' && Number(payload.is_context_correction) === 1) {
      console.log(`[Auto-Rollback] A/B Test phase semantic correction (is_context_correction=1) detected on v2-experimental! Initiating rollback.`);
      triggerRollback("A/B Test Phase Semantic Correction (is_context_correction=1) detected on v2-experimental");
    } else if (progressiveState.currentPhase === 'blue-green' && Number(payload.is_rage_click) === 1) {
      console.log(`[Auto-Rollback] High friction alert (is_rage_click=1) detected on v2-experimental! Initiating emergency rollback.`);
      triggerRollback("High Burn Rate Emergency Alert (is_rage_click=1) detected on v2-experimental");
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
    history: progressiveState.history
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
