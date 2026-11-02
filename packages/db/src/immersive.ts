import {
  DEFAULT_IMMERSIVE_SETTINGS,
  IMMERSIVE_LIMITS,
  type ImmersiveSettings,
  type ImmersiveUsage,
} from "@room/schemas";
import type { SqliteDatabase } from "./database";

/**
 * 沉浸模式设置和用量（C-42d / ADR-004 §3a，D-39）。
 *
 * 用量不单独存表：数 media_jobs 里最近 60 分钟、authorization = immersive 的任务。
 * - queued / running 也算（入队就占名额）
 * - 开始前被取消的（cancelled 且 started_at 为 NULL）退回名额
 * - 开始之后不管成功失败都算
 */

export function getImmersiveSettings(db: SqliteDatabase, conversationId: string): ImmersiveSettings {
  const row = db
    .prepare("SELECT * FROM chat_immersive_settings WHERE conversation_id = ?")
    .get(conversationId) as
    | {
        enabled: number;
        auto_draw_uses_subscription: number;
        draws_per_hour: number;
        voice_clips_per_hour: number;
      }
    | undefined;
  if (row === undefined) return { ...DEFAULT_IMMERSIVE_SETTINGS };
  return {
    enabled: row.enabled === 1,
    autoDrawUsesSubscription: row.auto_draw_uses_subscription === 1,
    drawsPerHour: row.draws_per_hour,
    voiceClipsPerHour: row.voice_clips_per_hour,
  };
}

export function upsertImmersiveSettings(
  db: SqliteDatabase,
  conversationId: string,
  settings: ImmersiveSettings,
  now: string,
): ImmersiveSettings {
  db.prepare(
    "INSERT INTO chat_immersive_settings (conversation_id, enabled, auto_draw_uses_subscription, draws_per_hour, " +
      "voice_clips_per_hour, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(conversation_id) DO UPDATE SET enabled = excluded.enabled, " +
      "auto_draw_uses_subscription = excluded.auto_draw_uses_subscription, draws_per_hour = excluded.draws_per_hour, " +
      "voice_clips_per_hour = excluded.voice_clips_per_hour, updated_at = excluded.updated_at",
  ).run(
    conversationId,
    settings.enabled ? 1 : 0,
    settings.autoDrawUsesSubscription ? 1 : 0,
    settings.drawsPerHour,
    settings.voiceClipsPerHour,
    now,
  );
  return settings;
}

/** 最近 60 分钟占掉的自动名额（和契约一样按 (now-60min, now] 算） */
export function immersiveUsage(db: SqliteDatabase, conversationId: string, now: string): ImmersiveUsage {
  const since = new Date(Date.parse(now) - 60 * 60 * 1000).toISOString();
  const count = (kind: "draw" | "speech") =>
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM media_jobs WHERE authorization = 'immersive' AND kind = ? " +
            "AND created_at > ? AND created_at <= ? " +
            "AND NOT (state = 'cancelled' AND started_at IS NULL) " +
            "AND json_extract(source, '$.kind') = 'chat' " +
            "AND json_extract(source, '$.conversationId') = ?",
        )
        .get(kind, since, now, conversationId) as { n: number }
    ).n;
  return { asOf: now, drawsLastHour: count("draw"), voiceClipsLastHour: count("speech") };
}

/**
 * 入队前原子地占名额：在写事务里调用，返回这次能不能自动执行。
 * 超了就不建任务，把原因写进消息的 immersiveDeferred（契约 ImmersiveDeferReason）。
 */
export function canReserveImmersive(
  db: SqliteDatabase,
  conversationId: string,
  settings: ImmersiveSettings,
  kind: "draw" | "speech",
  now: string,
): boolean {
  const usage = immersiveUsage(db, conversationId, now);
  return kind === "draw" ? usage.drawsLastHour < settings.drawsPerHour : usage.voiceClipsLastHour < settings.voiceClipsPerHour;
}

/** 设置里允许的最大值（契约常量），给界面校验用 */
export const IMMERSIVE_SETTINGS_MAX = {
  drawsPerHour: IMMERSIVE_LIMITS.drawsPerHour,
  voiceClipsPerHour: IMMERSIVE_LIMITS.voiceClipsPerHour,
} as const;
