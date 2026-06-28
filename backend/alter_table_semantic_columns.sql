-- DDL to alter existing ux_events_raw table to add semantic friction columns
-- BigQuery does not support adding columns with DEFAULT directly, so we add columns first, then update existing rows if any.

ALTER TABLE `test-2163-kobuchi-shu.friction_ops.ux_events_raw`
ADD COLUMN IF NOT EXISTS is_context_correction INT64;

ALTER TABLE `test-2163-kobuchi-shu.friction_ops.ux_events_raw`
ADD COLUMN IF NOT EXISTS is_context_deepening INT64;

-- Initialize null values to 0 for consistency
UPDATE `test-2163-kobuchi-shu.friction_ops.ux_events_raw`
SET is_context_correction = 0, is_context_deepening = 0
WHERE is_context_correction IS NULL OR is_context_deepening IS NULL;
