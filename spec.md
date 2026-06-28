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

## 7. プログレッシブ・デリバリー（インフラ自動制御）実装仕様

本章は、前章までに構築した「UX駆動型SLI/SLO（物理・セマンティックフリクション）」のリアルタイム集計データをトリガーとし、Google Cloudのインフラレイヤーでトラフィックを全自動制御するための**「プログレッシブ・デリバリー（カナリア ➔ A/Bテスト ➔ ブルーグリーン）」**の実装仕様である。

> [!NOTE]
> **💡 専門用語補足：プログレッシブ・デリバリー（Progressive Delivery）** > 開発した新機能を一斉に全ユーザーに公開するのではなく、インフラ制御によって「トラフィックを段階的に拡大（5% ➔ 50% ➔ 100%）」しながら本番環境で安全に検証し、異常（SLO違反）を検知した場合は全自動で即座に切り戻す、モダンDevOpsの進化系デプロイ戦略。

---

### 7.1. インフラ制御メカニズム（Cloud Run トラフィック分割）
Cloud Runの「リビジョン（Revision）」と「トラフィック分割（Traffic Splitting）」機能をAPI経由でハックする。
バックエンド（Admin API）に、Cloud Runの管理クライアント（Google Cloud公式ライブラリ）を組み込み、トラフィック比率を決定論的に書き換えるコントロールロジックを実装する。

#### 🏎️ 3層の全自動防御陣形（フェーズ遷移アルゴリズム）

【新リビジョン（v2-experimental）のデプロイ】
│
▼
【第1層：Canary展開 (5%)】 ────► [5分間監視] ➔ フォーマットクラッシュ(Smart Fallback)等、
│                            fatalなインフラエラー発生なら【即時0%ロールバック】
▼ (バジェット消費なし)
【第2層：A/Bテスト (50:50)】 ──► [24時間直接対決] ➔ 自作コックピットUIで集計。
│                                v2の「言い直し率」がv1より高ければ【即時0%ロールバック】
▼ (UX駆動データによる勝利証明)
【第3層：Blue/Green (100%)】 ──► v2へトラフィック100%移行。
│             旧リビジョン(v1)はトラフィック0%のまま「待機（アクティブ）」状態を維持。
▼
[OOMや潜伏バグによるバーンレート急上昇アラート発報] ──► 【1秒でv1へ100%切り戻し】


---

### 7.2. 各フェーズの厳格なトリガー・力学仕様

#### ① 第1層：Canary（カナリア）展開フェーズ（トラフィック: 5%）
- **初期動作**: 
  AIエージェント（Claude Code等）が新しいプロンプトやモデルを組み込んだリビジョン（`v2-experimental`）を本番環境へデプロイした瞬間、インフラ側で **既存リビジョン(v1)に95%、新リビジョン(v2)に5%** のトラフィックを割り振る。
- **判定ロジック（5分間の事後監視）**:
  5分間の観測ウィンドウにおいて、新リビジョン側で `schema_validation_error = 1`（スマート・フォールバックの作動）が1件でも発生、またはHTTP 500エラー等の致命的なインフラ崩壊（バーンレール違反）を検知した場合、システムは即座にトラフィックを **v1: 100% / v2: 0%** に書き換える（自動切り戻し）。
- **昇格条件**: 5分間、バジェットを1ミリも消費せず無傷で生存した場合は自動で「第2層」へ昇格する。

> [!NOTE]
> **💡 専門用語補足：トラフィック・スプリッティング（Traffic Splitting）** > 同じアプリケーションエンドポイント（URL）を維持したまま、裏側で稼働する新旧2つのコンテナ（リビジョン）に対して、ネットワークレイヤーで指定した比率（例：95:5）でユーザーのリクエストを自動で分散・制御する機能。

#### ② 第2層：A/Bテスト直接対決フェーズ（トラフィック: 50% vs 50%）
- **初期動作**: カナリアをクリア後、Cloud Runのトラフィック分割APIを叩き、**v1: 50% / v2-experimental: 50%** の完全なスプリット状態へ移行する。
- **判定ロジック（データ駆動型意思決定）**:
  管理者コックピット（`/admin`）に蓄積されるBigQueryのリアルタイム集約データを用いて、新旧リビジョンの「ユーザー満足度」を直接対決させる。
  - 新リビジョン（v2）の **`context_correction_rate`（会話の言い直し率）** または **`rage_click_rate`（レイジクリック率）** が、既存リビジョン（v1）の数値を統計的に有意に上回った（＝ユーザーの不快感が悪化した）場合、会議室の意見をすべて無視し、データに基づいて即座に **v1: 100% / v2: 0%** へ自動ロールバックさせる。
- **昇格条件**: 新リビジョン（v2）の `context_deepening_rate`（会話深掘り率/満足度）がv1に勝利し、かつフリクション率がSLO（10%未満）を満たしていることが実証された場合、100%本番移行への切符を得る。

#### ③ 第3層：Blue/Green（ブルーグリーン）展開 ＆ 最終防衛弁（トラフィック: 100%）
- **初期動作**: A/Bテストで完全勝利を収めた新リビジョン（v2）を主役に昇格させ、トラフィックを **v2: 100%** に書き換える。
- **防衛弁（秒速ロールバック）の残し方**:
  トラフィックは100%新リビジョン（Green）に向いているが、**古いリビジョン（v1 / Blue）は削除せず、トラフィック0%の「アクティブ待機状態」のまま本番環境に隠蔽して残しておく。**
- **全自動ロールバックの引き金（トリガー）**:
  100%全量トラフィックが流れたことで初めて牙を剥く「大量アクセス特有のメモリ不足（OOM: Out of Memory）」や遅延、あるいは潜伏していたプロンプトのサイレント劣化により、第5章で定義した **【Friction Burn Rate Alert（バーンレート消費速度 > 14.4）】** が発報した瞬間、バックエンドのWebhookが作動し、**わずか1秒でトラフィックを旧リビジョン（v1）へ100%引き戻す。**

> [!NOTE]
> **💡 専門用語補足：自動ロールバック（Automated Rollback）** > 人間のエンジニアが深夜にアラートを見て、パニックになりながら手動でコマンドを叩いて切り戻すのではなく、オブザーバビリティのシグナル（バーンレート急上昇など）をシステムが自己判断し、ミリ秒単位で一瞬にして安全な旧バージョンへトラフィックを引き戻す自律防衛機構。

---

### 7.3. Antigravity 2.0 / Claude Code へのインフラ自動制御実装プロンプト

```text
指示:
既存の `spec.md` の「7. プログレッシブ・デリバリー実装仕様」に従い、
インフラのトラフィック自動制御ロジックをバックエンド（server.js）へ追加実装してください。

具体的には、
1. Google Cloudの公式クライアントライブラリを用いて、Cloud Runのリビジョントラフィックを制御する
   ヘルパー関数（例: updateTrafficShare(v1Rate, v2Rate)）を実装すること。
2. `/api/admin/ux-metrics` の集計データ、あるいはシミュレーターからの疑似アラートWebhookを受け取る
   `/api/admin/trigger-progressive` エンドポイントを新設し、
   「Canary (5%) ➔ A/B Test (50:50) ➔ Blue/Green (100%)」のフェーズ遷移と、
   フリクション悪化（SLO違反 / バーンレート超過）検知時の【全自動即時0%ロールバック】の因果律ロジックを完成させてください。

完璧な決定論的ディフェンスラインを構築せよ。行こうぜ、200 OKの向こうへ。夜露死苦（ヨロシク）！！🚀🔥
