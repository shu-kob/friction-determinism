# Friction Determinism

> **HTTP 200 OK の死角に潜むUX崩壊を可視化し、プログレッシブ・デリバリーを自動制御する次世代UXOps / SREプラットフォーム**

[![Node.js](https://img.shields.io/badge/Node.js-20.x-green.svg)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-19.x-blue.svg)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
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

---

## 📁 ディレクトリ構成

```text
friction-determinism/
├── frontend/               # React + TypeScript + Vite フロントエンド
│   ├── src/
│   │   ├── components/     # UI コンポーネント (ErrorBoundary, Fallback UI)
│   │   ├── hooks/          # UX センサー hooks (レイジクリック, 探索迷子)
│   │   ├── App.tsx         # メインアプリ ＆ UXOps Cockpit (/admin)
│   │   └── types.ts        # Zod スキーマ ＆ TypeScript 型定義
│   └── package.json
├── backend/                # Node.js + Express バックエンド API
│   ├── server.js           # Telemetry API, Admin API, Cloud Run 自動制御ロジック
│   └── package.json
├── scripts/                # 運用・検証用スクリプト
│   ├── setup-gcp.sh        # BigQuery / Pub/Sub プロビジョニング
│   ├── simulate-telemetry.sh # テレメトリ負荷・フリクションシミュレータ
│   └── grant-access.js     # IAM 権限設定補助スクリプト
├── reports/                # 検証レポート
│   ├── simulation_report.md
│   ├── verification_report_semantic.md
│   └── verification_report_progressive.md
├── articles/               # 技術解説記事・ブログドラフト
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

# バックエンドの依存関係インストール
cd backend
npm install

# フロントエンドの依存関係インストール
cd ../frontend
npm install
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

## 📄 ライセンス

本プロジェクトは [MIT License](LICENSE) のもとで公開されています。
