# Friction Determinism

> **HTTP 200 OK の死角に潜むUX崩壊を可視化し、プログレッシブ・デリバリーを自動制御する次世代UXOps / SREプラットフォーム**

[![Node.js](https://img.shields.io/badge/Node.js-20.x-green.svg)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-19.x-blue.svg)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Playwright](https://img.shields.io/badge/Playwright-E2E%20Chaos-45ba4b.svg)](https://playwright.dev/)
[![Google Cloud](https://img.shields.io/badge/Google%20Cloud-Cloud%20Run%20%7C%20Pub%2FSub%20%7C%20BigQuery%20%7C%20Vertex%20AI-orange.svg)](https://cloud.google.com/)
[![License](https://img.shields.io/badge/License-MIT-lightgrey.svg)](LICENSE)

---

## 📖 概要

現代のWebアプリケーションや生成AIサービスにおいて、従来のAPMやインフラ監視（SRE）は **「HTTP 200 OK が返っていれば正常」** と判断します。

しかし、その裏側では以下のような **「深刻なUXフリクション（つまづき・ストレス）」** が発生しています：
- 反応が遅くイライラしたユーザーによる **レイジクリック（怒りの連打）**
- 導線や履歴を見失った **探索迷子（ピンポン往復遷移）**
- 生成AIの出力JSON崩れによる **Smart Fallback（フォールバックUIの裏で発生した例外）**
- 的外れなAIの回答に対してユーザーが条件を再説明・言い直す **セマンティック・フリクション（意味論的ストレス）**

**Friction Determinism** は、これらユーザーの主観的ストレスをクライアントおよびLLMセンサーによって **決定論的なデジタルシグナル（0 or 1）** として捕捉・集計します。  
さらに、そのリアルタイムデータをトリガーとして **Cloud Run のプログレッシブ・デリバリー（Canary ➔ A/B ➔ Blue/Green）および自動ロールバック** を実行する、自己修復型のUXOps基盤を提供します。

---

## 🏗️ システムアーキテクチャ

```text
[React App (Frontend: User UI & Admin Cockpit)]
  │
  ├─ 1. Zod Schema Validation & 物理フリクション検知 (Rage Click / 探索迷子)
  ├─ 2. セマンティック・フリクションセンサー (Gemini Flash による非同期文脈判定)
  └─ 3. Smart Fallback UI (ErrorBoundary で画面クラッシュ防止 ＆ テレメトリ裏流し)
        │
        ▼ (POST /api/telemetry - 非同期 Beacon 送信)
[Cloud Run: Telemetry & Admin API (Backend)]
  │
  ├─► [Cloud Pub/Sub: ux-events-topic]
  │     │ (Decoupled Streaming Buffer)
  │     ▼
  │   [BigQuery: friction_ops.ux_events_raw] (日次パーティション / クラスタリング)
  │     │
  │     ├─► [Cloud Monitoring / MQL] ──► 【Friction Burn Rate Alert】
  │     │
  │     └─► [Admin API (GET /api/admin/ux-metrics)] ──► [UXOps Cockpit (/admin)]
  │
  └─► 【3層プログレッシブ・デリバリー自動制御ロジック】
        │ (Cloud Run API: Traffic Splitting)
        ▼
      [Cloud Run Service Revisions]
        - v1: 既存安定版
        - v2-experimental: 新プロンプト / 新機能（Canary 5% ➔ A/B 50% ➔ Blue/Green 100%）
        ※ SLO違反検知時に 1 秒で 0% へ自動ロールバック
```

---

## ✨ 主要機能

### 1. 決定論的 UX センサー（Frontend）
フロントエンド上でユーザーの行動を監視し、厳格な Zod スキーマで定義されたデジタル信号へ変換します。
- **レイジクリック検知**: 1秒間に5回以上の連続クリックを検知 (`is_rage_click = 1`)
- **探索迷子検知**: 30秒間に3画面以上のルートを4回以上往復した迷走状態を検知 (`is_maigo = 1`)
- **Smart Fallback & ErrorBoundary**: 生成AIのフォーマット崩れ等によるクラッシュを画面上は上品なローディング・フォールバックで救済しつつ、裏側でエラーシグナルを収集 (`schema_validation_error = 1`)
- **セマンティック・フリクションセンサー**: 会話の追従発話時に Gemini Flash が非同期で「言い直し・不満」または「深掘り」を2値判定 (`is_context_correction = 1`, `is_context_deepening = 1`)

### 2. UXOps Cockpit（管理画面 `/admin`）
「200 OK のホワイトアウト」を剥ぎ取るための専用ダッシュボードです。
- **Infrastructure SLO (Green)**: 常時 100% に近い従来の HTTP 稼働率
- **User Satisfaction SLO (Red/Yellow)**: `100% - つまづき率` で算出される「真のUX健全性」
- **詳細推移グラフ**: レイジクリック率、迷子率、スマートフォールバック率、言い直し率、深掘り率のタイムライン可視化
- **デリバリーステータス & 手動/自動介入パネル**

### 3. 3層プログレッシブ・デリバリー自動制御
Cloud Run のトラフィック分割（Traffic Splitting）機能を API 経由で制御し、安全なリリースサイクルを実現します。
- **第1層：Canary（5%展開）**
  - デプロイ直後の5分間、致命的エラー（`schema_validation_error`）やインフラ障害を監視。1件でも検知した瞬間に **即時 0% ロールバック**。
- **第2層：A/Bテスト（50:50直接対決）**
  - セマンティック指標（言い直し率）を既存リビジョンと比較。新バージョンのUX劣化が証明された場合は **自動ロールバック**。
- **第3層：Blue/Green（100%昇格）**
  - 全トラフィックを移行。旧リビジョンは即座に待機状態（0%）を維持し、バーンレート急上昇時には **1秒で旧リビジョンへ100%即時復帰**。

### 4. 次世代 Gemini 3モデル適材適所オーケストレーション
単一のLLMではなく、レイテンシ・推論能力・FinOpsコストの観点から3モデルを適材適所に使い分けます。
| モデル | 配置箇所・役割 | 性能・FinOps特性 |
| :--- | :--- | :--- |
| **⚡ Gemini 3.5 Flash-Lite** | **リアルタイム・セマンティックセンサー**<br>毎発話の言い直し（不満）/ 深掘りを 0 or 1 で判定 | 遅延 < 50ms<br>超低コスト ($0.0375 / 1M) |
| **🎯 Gemini 3.8 Flash** | **プログレッシブ判定 ＆ Cockpit UXサマリー**<br>A/Bテスト集計データから昇格/ロールバックを複合判定 | 遅延 ~ 200ms<br>推論と速度の最適バランス |
| **🧠 Gemini 4 Argon** | **インシデント深層RCA ＆ 改善プロンプトDiff提案**<br>1秒ロールバック発動後、異常ログを推論し事後分析レポートを自律生成 | 最上位の推論能力<br>事後分析時のみ発動 |

### 5. Playwright による「UXカオスエンジニアリング」検証
Playwright を単なる機能テストではなく、**「擬似ユーザーによるUXカオス・シミュレータ」** として活用。
- **シナリオ1 (レイジクリック)**: 1秒間に高速連打を行い `is_rage_click = 1` の発火を検証
- **シナリオ2 (探索迷子)**: 30秒間に3画面以上4往復のピンポン遷移を行い `is_maigo = 1` を検証
- **シナリオ3 (Canary自動ロールバック)**: 意図的に壊れたJSONを注入し、Smart Fallback ➔ テレメトリ即時裏流し ➔ Cloud Run 1秒自動ロールバック ➔ Gemini 4 Argon ポストモーテム生成の一連の因果律を CI 上で完全証明

---

## 📁 ディレクトリ構成

```text
friction-determinism/
├── frontend/               # React 19 + TypeScript + Vite フロントエンド
│   ├── src/
│   │   ├── components/     # UI コンポーネント (ErrorBoundary, Fallback UI)
│   │   ├── hooks/          # UX センサー hooks (レイジクリック, 探索迷子)
│   │   ├── App.tsx         # メインアプリ ＆ UXOps Cockpit (/admin)
│   │   └── types.ts        # Zod スキーマ ＆ TypeScript 型定義
│   └── package.json
├── backend/                # Node.js + Express バックエンド API
│   ├── server.js           # Telemetry API, Admin API, Gemini 3モデル連携, Cloud Run 自動制御
│   └── package.json
├── e2e/                    # Playwright による UX カオスエンジニアリング自動テスト
│   ├── 01-rage-click.spec.ts      # 怒りの連打シミュレーション
│   ├── 02-maigo.spec.ts           # 探索迷子・ピンポン遷移シミュレーション
│   └── 03-canary-rollback.spec.ts # Canary 5% ➔ スキーマ破壊 ➔ 自動ロールバック ➔ ポストモーテム
├── scripts/                # 運用・検証用スクリプト
│   ├── setup-gcp.sh        # BigQuery / Pub/Sub プロビジョニング
│   ├── simulate-telemetry.sh # テレメトリ負荷・フリクションシミュレータ
│   └── grant-access.js     # IAM 権限設定補助スクリプト
├── reports/                # 検証レポート
│   ├── simulation_report.md
│   ├── verification_report_semantic.md
│   └── verification_report_progressive.md
├── articles/               # 技術解説記事・ブログドラフト
├── playwright.config.ts    # Playwright E2E 設定ファイル
├── spec.md                 # 詳細システム仕様書
├── Dockerfile              # マルチステージ本番用コンテナ定義
└── README.md
```

---

## 🚀 クイックスタート（ローカル環境）

GCP の認証情報（ADC）がない環境でも、バックエンドは **ローカルモックモード（インメモリDB / モックLLM）** に自動でフォールバックするため、すぐに動作確認が可能です。

### 1. 前提条件
- Node.js 20.x 以上
- npm 10.x 以上

### 2. インストール

```bash
# リポジトリのクローン
git clone https://github.com/shu-kob/friction-determinism.git
cd friction-determinism

# プロジェクト全体の依存関係インストール (ルート, backend, frontend)
npm install
cd backend && npm install
cd ../frontend && npm install
cd ..
```

### 3. Playwright E2E カオスシミュレーションの実行

ワンコマンドでフロントエンドのビルド・サーバー起動・3大カオステストを実行できます：

```bash
# ヘッドレスでE2Eテストを実行 (全3シナリオ自動実証)
npm run test:e2e

# ブラウザUIでステップ実行を確認したい場合
npm run test:e2e:ui
```

### 4. ローカル開発サーバーの起動

```bash
# ターミナル 1: バックエンド起動 (ポート 5001)
npm run dev:backend

# ターミナル 2: フロントエンド起動 (ポート 5173)
npm run dev:frontend
```

### 3. バックエンドの起動

```bash
cd backend
npm run dev
# ポート 5001 (または環境変数 PORT) で Express サーバーが起動します
```

### 4. フロントエンドの起動

別ターミナルを開いて実行します：

```bash
cd frontend
npm run dev
# Vite 開発サーバーが起動します (http://localhost:5173)
```

### 5. 画面へのアクセス
- **ユーザー体験デモ画面**: [http://localhost:5173/](http://localhost:5173/)
  - チャット入力、レイジクリック、画面遷移迷子、AIエラーフォールバックを試すことができます。
- **UXOps Cockpit（管理画面）**: [http://localhost:5173/admin](http://localhost:5173/admin)
  - リアルタイムなSLOグラフや、プログレッシブ・デリバリーの制御シミュレーションが確認できます。

---

## ☁️ Google Cloud へのデプロイ ＆ 本番環境構築

### 1. GCP リソースのプロビジョニング
BigQuery データセット・テーブル、Pub/Sub トピック・サブスクリプションを自動作成します。

```bash
# プロジェクトIDを設定して実行
export GCP_PROJECT="your-gcp-project-id"
bash scripts/setup-gcp.sh
```

### 2. コンテナのビルド ＆ Cloud Run へのデプロイ

```bash
# Cloud Build によるビルド
gcloud builds submit --tag gcr.io/${GCP_PROJECT}/friction-determinism:v1

# Cloud Run へのデプロイ
gcloud run deploy friction-determinism-poc \
  --image gcr.io/${GCP_PROJECT}/friction-determinism:v1 \
  --platform managed \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --set-env-vars GCP_PROJECT=${GCP_PROJECT},NODE_ENV=production
```

### 3. テレメトリシミュレーションの実行
バックエンドに対して大量の正常/フリクションイベントを流し込み、BigQuery や Cockpit への反映をテストします。

```bash
# 対象URLを指定して実行
bash scripts/simulate-telemetry.sh https://your-cloud-run-service-url.run.app
```

---

## 📊 UX駆動型 SLI / SLO 定義

| 指標名 | 数式 / 条件 | ターゲット (SLO) |
| :--- | :--- | :--- |
| **UX Satisfaction SLI** | `1.0 - (フリクション発生イベント数 / 全UXイベント数)` | **90% 以上**（つまづき率 10% 未満） |
| **物理フリクション** | `is_rage_click = 1` OR `is_maigo = 1` | 5% 未満 |
| **スキーマ破壊** | `schema_validation_error = 1` | 0.5% 未満 |
| **セマンティック・フリクション** | `is_context_correction = 1` | 10% 未満 |
| **バーンレートアラート** | 1時間のエラー予算を短時間（5分）で14.4倍以上の速度で消費した場合 | 即時通知・自動ロールバック |

---

## 📚 ドキュメント & レポート

- [詳細システム仕様書 (spec.md)](./spec.md)
- [プログレッシブ・デリバリー検証レポート](./reports/verification_report_progressive.md)
- [セマンティック・フリクションセンサー検証レポート](./reports/verification_report_semantic.md)
- [テレメトリパイプライン負荷シミュレーションレポート](./reports/simulation_report.md)

---

## 📖 技術書典 合同誌 執筆構成案（14〜16P想定）

**仮タイトル**: 『HTTP 200 OKの嘘を暴く！Playwright × Cloud Runで作る自己修復型UXOps基盤』  
〜Gemini 3.8 Flash / 4 Argon / 3.5 Flash-Lite による決定論的UX監視〜

| 節 | ページ数 | 内容・掲載コード／図版 |
| :--- | :---: | :--- |
| **第1節: はじめに** | 2P | ・なぜ「HTTP 200 OK」なのにユーザーは静かに離脱するのか？<br>・従来のSRE（インフラ稼働率）の死角とAI時代のサイレントUX崩壊<br>・主観的なストレスを 0 or 1 の決定論的シグナルに変換する設計思想 |
| **第2節: 全体アーキテクチャ ＆ 3世代Geminiの適材適所** | 3P | ・React + Cloud Run + Pub/Sub + BigQuery + UXOps Cockpit の全体図<br>・3.5 Flash-Lite（全量監視）/ 3.8 Flash（リリース判定）/ 4 Argon（根本原因分析）の使い分けとFinOpsコスト試算表 |
| **第3節: クライアント ＆ LLMセンサーの実装** | 3P | ・Zod スキーマによる出力崩れ検知と Smart Fallback UI<br>・レイジクリック・探索迷子の検知ロジック（`hooks/` の解説）<br>・Gemini 3.5 Flash-Lite による非同期「言い直し（セマンティック・フリクション）」判定コード |
| **第4節: Playwright による「UXカオス注入」と自動E2E検証** | 3P | ・怒りの連打・画面往復迷子を Playwright で再現するテストコード抜粋<br>・sendBeacon / keepalive 通信を Playwright で決定論的にインターセプトする実践Tips<br>・自動テスト実行ログとエビデンス |
| **第5節: Cloud Run Traffic Splitting による3層プログレッシブ・デリバリー** | 3P | ・Canary (5%) → A/B (50:50) → Blue/Green (100%) の自動制御ロジック<br>・バーンレート急上昇時の「1秒自動ロールバック」の因果律<br>・Gemini 4 Argon が自律生成したポストモーテム（RCA & プロンプト修正Diff）の掲載 |
| **第6節: おわりに** | 1P | ・SREの次なるフロンティアとしてのUXOps<br>・「壊れたら戻す」から「ユーザーがつまづいたら戻す」自律修復クラウドへ |

---

## 📄 ライセンス

本プロジェクトは [MIT License](LICENSE) のもとで公開されています。
