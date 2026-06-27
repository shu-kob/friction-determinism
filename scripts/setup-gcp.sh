#!/bin/bash
set -euo pipefail

PROJECT_ID="test-2163-kobuchi-shu"
LOCATION="asia-northeast1"
DATASET="friction_ops"
TABLE="ux_events_raw"
TOPIC="ux-events-topic"
SUBSCRIPTION="ux-events-bq-sub"

echo "=== Setting active project ==="
gcloud config set project "${PROJECT_ID}"

echo "=== 1. Creating BigQuery Dataset and Table ==="
bq query --use_legacy_sql=false "
CREATE SCHEMA IF NOT EXISTS \`${PROJECT_ID}.${DATASET}\`
OPTIONS(location=\"${LOCATION}\");
"

bq query --use_legacy_sql=false "
CREATE TABLE IF NOT EXISTS \`${PROJECT_ID}.${DATASET}.${TABLE}\` (
  session_id STRING NOT NULL,
  user_id STRING,
  current_route STRING NOT NULL,
  timestamp TIMESTAMP NOT NULL,
  revision_id STRING NOT NULL,
  is_rage_click INT64 NOT NULL,
  is_maigo INT64 NOT NULL,
  schema_validation_error INT64 NOT NULL,
  stay_duration_seconds FLOAT64 NOT NULL,
  regenerate_count INT64 NOT NULL,
  raw_error_message STRING
)
PARTITION BY DATE(timestamp)
CLUSTER BY revision_id;
"

echo "=== 2. Creating Pub/Sub Topic ==="
if gcloud pubsub topics describe "${TOPIC}" >/dev/null 2>&1; then
  echo "Topic ${TOPIC} already exists."
else
  gcloud pubsub topics create "${TOPIC}"
fi

echo "=== 3. Getting Project Number and Granting Pub/Sub Permissions ==="
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format="value(projectNumber)")
PUBSUB_SA="service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"

echo "Granting BigQuery roles to Pub/Sub Service Account: ${PUBSUB_SA}"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${PUBSUB_SA}" \
    --role="roles/bigquery.dataEditor" \
    --condition=None

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${PUBSUB_SA}" \
    --role="roles/bigquery.metadataViewer" \
    --condition=None

echo "=== 4. Creating Pub/Sub BigQuery Subscription ==="
if gcloud pubsub subscriptions describe "${SUBSCRIPTION}" >/dev/null 2>&1; then
  echo "Subscription ${SUBSCRIPTION} already exists."
else
  # Create BigQuery subscription mapping JSON fields to table columns
  gcloud pubsub subscriptions create "${SUBSCRIPTION}" \
      --topic="${TOPIC}" \
      --bigquery-table="${PROJECT_ID}:${DATASET}.${TABLE}" \
      --use-topic-schema=false
fi

echo "=== GCP Provisioning Complete! ==="
