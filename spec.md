# Friction Determinism システム仕様書

## 1. システムアーキテクチャ全体像

```
[React App (Frontend)]
  │ (User Actions & LLM Outputs)
  ├─ 1. Zod Schema Validation & Catching Frictions (Rage Click, Maigo, Error)
  ├─ 2. Semantic Friction Sensor (Async context analysis using Gemini Flash)
  └─ 3. Smart Fallback UI (ErrorBoundary)
        ▼
[Cloud Run: Telemetry API (Backend)]
  │ (Asynchronous Ingestion via POST /api/telemetry)
  ▼
[Cloud Pub/Sub: ux-events-topic]
  │ (Decoupled Streaming Buffering)
  ▼
[BigQuery: friction_ops.ux_events_raw] (Log Sink / Streaming Ingestion)
  │
  ├─► [Cloud Monitoring / MQL] ──► 【Friction Burn Rate Alert】
  │     (Friction SLO Calculation)
  │
  └─► [Cloud Run: Admin API] ────► [React Admin UI: /admin]
        (Real-time SQL Aggregation)     【UXOps Cockpit (可視化)】
```

---

## 2. 目的とアプローチ
本システムは、ウェブアプリケーションにおけるユーザーの「フリクション（つまづきやストレス）」を決定論的なデジタル信号として検知・収集し、インフラ稼働率（HTTP 200 OK）の死角に隠れたUX低下を可視化・監視するためのデータパイプラインおよびモニタリング環境を構築する。

---

## 3. フロントエンド（React）センサー実装仕様

フロントエンドは、ユーザーの脳内カオス（ストレス）を決定論的なデジタル信号にパースする「センサー」として機能させる。

### 3.1. UXイベントのデータ構造（Zodによる型定義）
不確実なJavaScriptオブジェクトに対し、厳格な決定論的バリデーションをかけるため `zod` を使用してスキーマを定義する。

```typescript
import { z } from 'zod';

export const UXEventSchema = z.object({
  session_id: z.string().uuid(),
  user_id: z.string().optional(),
  current_route: z.string(),
  timestamp: z.string().datetime(),
  revision_id: z.string().default('v1'), // 今後の拡張用（デフォルトはv1固定）
  
  // 決定論的シグナル（0 or 1）
  is_rage_click: z.number().int().min(0).max(1),
  is_maigo: z.number().int().min(0).max(1),
  schema_validation_error: z.number().int().min(0).max(1),
  
  // 会話コンテキスト・シグナル（0 or 1）
  is_context_correction: z.number().int().min(0).max(1).default(0),
  is_context_deepening: z.number().int().min(0).max(1).default(0),
  
  // 定量的メトリクス
  stay_duration_seconds: z.number().min(0),
  regenerate_count: z.number().int().nonnegative(),
  raw_error_message: z.string().optional()
});

export type UXEvent = z.infer<typeof UXEventSchema>;
```

> [!NOTE]
> **💡 専門用語補足：セマンティック・フリクション（Semantic Friction）**  
> UIのボタンが押しづらいといった物理的な不快感ではなく、AIの返答が的外れなために、ユーザーが「言葉の言い直しや条件の再説明」を強いられているという、意味論（文脈）上のストレスのこと。

### 3.2. フリクション（つまづき）検知ロジック
以下の4つの検知ロジックを実装すること。

#### ① レイジクリック（怒りの連打）検知
- **定義**: 同一のDOM要素、または画面全体の任意の場所が「1秒間に5回以上」連続でクリックされた場合。
- **処理**: `is_rage_click = 1` をセット。バックエンドの遅延や、UIフィードバックの欠如によるユーザーのイライラを決定論的に捕捉する。

#### ② 探索迷子（ルーティングのピンポン往復）検知
- **定義**: 短時間（30秒以内）に、3つ以上の異なる画面（ルート）を4回以上往復（例: A ➔ B ➔ A ➔ B ➔ C ➔ A）している場合。
- **処理**: `is_maigo = 1` をセット。ユーザーが目的の画面やAIの回答履歴にたどり着けずに迷走している状態（UXフリクション）を捕捉。

#### ③ スマート・フォールバック ＆ ErrorBoundary 連携
- **定義**: バックエンド（Vertex AI）から返却された生成AIの出力JSONフォーマットが崩れ、Zodのパースエラーが発生、あるいはコンポーネントがクラッシュした場合。
- **処理**:
  - **【表の顔（UX救済）】**: `ErrorBoundary` が作動し、ユーザーには「AIが少し考え込んでいます」という上品なローディング・またはスマート・フォールバックUIを表示（画面のホワイトアウトを絶対防ぐ）。
  - **【裏の顔（SRE防衛）】**: 裏側で `schema_validation_error = 1` をセットし、例外の生メッセージ（`raw_error_message`）を奪取してテレメトリパイプラインへ即座に裏流しする。

#### ④ 会話文脈（セマンティック）センサー
- **定義**: ユーザーから2回目以降のチャット（追従発話）が届いた際、メイン処理とは完全に非同期のバックグラウンド処理で、高速な判定用LLM（Gemini Flash等）を動かして文脈を2値判定する。
- **処理**:
  - AIの1つ前の返答に対して、ユーザーが条件を言い直したり、的外れな点に怒っている場合 ➔ `is_context_correction = 1`
  - AIの返答が的確で、ユーザーがさらに知識を深掘りしようとしている場合 ➔ `is_context_deepening = 1`

### 3.3. テレメトリデータの非同期送信
- **エンドポイント**: `POST /api/telemetry`
- **送信仕様**: メインのアプリケーションロジック（LLMとのチャット通信など）のパフォーマンスを絶対阻害しないよう、非同期（Background Worker または `navigator.sendBeacon` / `fetch`の `keepalive: true`）で送信を完結させる。

---

## 4. バックエンド（Cloud Run）＆ データパイプライン仕様

### 4.1. Telemetry API エンドポイント
- **実行環境**: Cloud Run (Node.js/Express または Python/FastAPI)
- **役割**: フロントエンドから届いたUXイベントを検証し、ミリ秒単位で Cloud Pub/Sub へパブリッシュする。データベース等への同期的な書き込みは一切行わず、バックプレッシャーを回避する。

### 4.2. Cloud Pub/Sub 設定
- **トピック名**: `ux-events-topic`
- **サブスクリプション**: BigQueryへの直接書き込みを行うため、BigQueryへのプッシュ（Streaming Ingestion）サブスクリプション、またはログシンク経由のアーキテクチャを採用する。

### 4.3. BigQuery テーブル定義（データウェアハウス）
- **データセット名**: `friction_ops`
- **テーブル名**: `ux_events_raw`
- **パーティション**: `timestamp` による日次パーティショニング、および `revision_id` によるクラスタリングを設定。

#### スキーマ構造（SQL DDLイメージ）
```sql
CREATE TABLE `your_project.friction_ops.ux_events_raw` (
  session_id STRING NOT NULL,
  user_id STRING,
  current_route STRING NOT NULL,
  timestamp TIMESTAMP NOT NULL,
  revision_id STRING NOT NULL,
  is_rage_click INT64 NOT NULL,
  is_maigo INT64 NOT NULL,
  schema_validation_error INT64 NOT NULL,
  is_context_correction INT64 NOT NULL DEFAULT 0,
  is_context_deepening INT64 NOT NULL DEFAULT 0,
  stay_duration_seconds FLOAT64 NOT NULL,
  regenerate_count INT64 NOT NULL,
  raw_error_message STRING
)
PARTITION BY DATE(timestamp)
CLUSTER BY revision_id;
```

#### DDL構造の拡張用（既存テーブルへの適用）
```sql
ALTER TABLE `your_project.friction_ops.ux_events_raw`
ADD COLUMN is_context_correction INT64 DEFAULT 0,
ADD COLUMN is_context_deepening INT64 DEFAULT 0;
```

---

## 5. モニタリング ＆ アラート仕様（Cloud Monitoring）

「200 OK」のホワイトアウトを剥ぎ取るための、UX駆動型SLI/SLOおよびバーンレートアラートの数式定義。

### 5.1. UX駆動型SLI（つまづき率）の定義

#### SLI（Service Level Indicator）
$$\text{UX駆動型つまづき率} = \frac{\text{is\_rage\_click} = 1 \text{ または } \text{is\_maigo} = 1 \text{ または } \text{schema\_validation\_error} = 1 \text{ または } \text{is\_context\_correction} = 1 \text{ であるイベント数}}{\text{全UXイベント総数}}$$

#### SLO（Service Level Objective）
「1時間あたり、全ユーザーセッションにおけるUX駆動型つまづき率を **10%未満** に抑える（信頼性＝満足性90%以上）」。

### 5.2. バーンレート（燃焼率）アラートの設計
単純な「しきい値」での監視ではなく、エラーバジェット（予算）の消費速度を監視する。

- **アラート条件**: 短時間（例: 5分間）で、1時間分のエラーバジェットを14.4倍の速度で消費（バーンレート > 14.4）した場合に即座に発報。
- **通知チャネル**: Slack / 開発者への即時発報。
- **本フェーズの範囲**: 本フェーズでは自動ロールバックの手前である「アラート発報」までを完璧にテストする。

---

## 6. 管理者機能（UXOps Cockpit）実装仕様

インフラ監視画面では見えない真実を暴く、自分たちのための「コックピット（管理画面）」の実装。

### 6.1. 管理者用 API エンドポイント
- **実行環境**: Cloud Run (バックエンド)
- **エンドポイント**: `GET /api/admin/ux-metrics`
- **処理内容**: React管理画面からのリクエストを受け、バックエンドが BigQuery に対し、直近1時間〜24時間のUXデータを集計する以下のクエリを実行してJSONで返却する。

#### BigQuery リアルタイム集約クエリ（SQL）
```sql
SELECT 
  revision_id,
  COUNT(*) as total_sessions,
  
  -- つまづき率の算出
  ROUND(COUNT(CASE WHEN is_rage_click = 1 THEN 1 END) * 100.0 / COUNT(*), 2) as rage_click_rate,
  ROUND(COUNT(CASE WHEN is_maigo = 1 THEN 1 END) * 100.0 / COUNT(*), 2) as maigo_rate,
  ROUND(COUNT(CASE WHEN schema_validation_error = 1 THEN 1 END) * 100.0 / COUNT(*), 2) as smart_fallback_rate,
  
  -- 【新規追記】会話のズレ・深掘り率の算出
  ROUND(COUNT(CASE WHEN is_context_correction = 1 THEN 1 END) * 100.0 / COUNT(*), 2) as context_correction_rate,
  ROUND(COUNT(CASE WHEN is_context_deepening = 1 THEN 1 END) * 100.0 / COUNT(*), 2) as context_deepening_rate,
  
  -- ユーザーの定量的行動の算出
  ROUND(AVG(stay_duration_seconds), 1) as avg_stay_duration,
  SUM(regenerate_count) as total_regenerate_press
FROM `your_project.friction_ops.ux_events_raw`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
GROUP BY revision_id;
```

### 6.2. コックピットUI（React Admin画面 `/admin`）

- **見た目・デザイン**: ダークモードを基調とし、一目でビジネスの危険性がわかるUI（キャプチャイメージの通り）。
- **主要な配置コンポーネント**:
  - **【Infrastructure SLO (Green)】**: HTTP 200 OK の稼働率（常時 100% に近い安全な値をダミー、または Cloud Monitoring API から取得して表示）。
  - **【User Satisfaction SLO (Red/Yellow)】**: 上記SQLの集約結果から算出される「真の満足度（100% - つまづき率）」。インフラがGreenなのにここがRedに染まる「200 OKの死角」をドラマチックに表現する。
  - **【Detail Analysis Charts】**: `is_maigo`、`is_rage_click`、`schema_validation_error`、およびセマンティック指標である `is_context_correction`, `is_context_deepening` のタイムライン推移グラフ。
