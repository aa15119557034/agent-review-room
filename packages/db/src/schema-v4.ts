/**
 * 迁移 v4（C-40 / 1B-0）：模型选择。
 *
 * - agents.model_settings：参与者的首选 / 备选模型和各场合强度（JSON；NULL = 没设置，读出来用默认值）
 * - batch_items.model：起草时定下的模型和强度（JSON；NULL = 用 profile 自带模型，1A 旧批次也是 NULL）
 *
 * 只加可空列，不重建表：旧行一律 NULL，读的时候由 repository 补默认值。
 */
export const SCHEMA_V4 = `
ALTER TABLE agents
  ADD COLUMN model_settings TEXT CHECK (model_settings IS NULL OR json_valid(model_settings));

ALTER TABLE batch_items
  ADD COLUMN model TEXT CHECK (model IS NULL OR json_valid(model));
`;
