import { useId, type CSSProperties } from "react";
import type { AgentModelSettings, ModelOption, RunOccasion } from "@room/schemas";
import { OCCASIONS, modelLabel } from "../lib/models";

/**
 * 秘书资料页里的「模型和思考强度」（C-41，画布「模型和思考强度」）。
 * 能选什么全由节点上报（C-40 的 profileModels），这里不写死任何模型名或档位。
 * models：undefined = 还在问节点；null = 节点没报；[] = 这个 profile 的模型写死在节点上。
 */
export function ModelSettings({
  value,
  models,
  onChange,
}: {
  value: AgentModelSettings;
  models: ModelOption[] | null | undefined;
  onChange: (next: AgentModelSettings) => void;
}) {
  if (models === undefined) return <p className="step-hint">正在问节点有哪些模型……</p>;
  if (models === null || models.length === 0) {
    return (
      <div className="model-settings">
        <p className="step-hint">
          {models === null
            ? "节点没有上报可选的模型（节点是老版本、连不上，或者没有这个 profile），会用 profile 自带的模型和强度。"
            : "这个 profile 的模型写死在节点配置里，不能在这里选。"}
        </p>
        {value.primaryModel !== null && (
          <p className="step-hint">
            已保存的设置：首选 <code>{value.primaryModel}</code>
            {value.fallbackModel !== null && <>，备选 <code>{value.fallbackModel}</code></>}。节点能选模型以后才会生效。
          </p>
        )}
      </div>
    );
  }

  const primary = models.find((m) => m.id === value.primaryModel);
  const set = (patch: Partial<AgentModelSettings>) => onChange({ ...value, ...patch });
  const setEffort = (occasion: RunOccasion, effort: string | null) => set({ effort: { ...value.effort, [occasion]: effort } });

  return (
    <div className="model-settings">
      <div className="node-fields">
        <label>
          首选模型
          <select
            className="settings-input"
            value={value.primaryModel ?? ""}
            onChange={(e) => {
              const id = e.target.value || null;
              set({ primaryModel: id, fallbackModel: id === null || value.fallbackModel === id ? null : value.fallbackModel });
            }}
          >
            <option value="">（跟随 profile 自带的）</option>
            {value.primaryModel !== null && !primary && <option value={value.primaryModel}>{value.primaryModel}（节点上没有）</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.displayName}</option>
            ))}
          </select>
        </label>
        <label>
          备选模型（首选用不了时换上）
          <select
            className="settings-input"
            value={value.fallbackModel ?? ""}
            disabled={value.primaryModel === null}
            onChange={(e) => set({ fallbackModel: e.target.value || null })}
          >
            <option value="">（没有备选）</option>
            {value.fallbackModel !== null && !models.some((m) => m.id === value.fallbackModel) && (
              <option value={value.fallbackModel}>{value.fallbackModel}（节点上没有）</option>
            )}
            {models.filter((m) => m.id !== value.primaryModel).map((m) => (
              <option key={m.id} value={m.id}>{m.displayName}</option>
            ))}
          </select>
        </label>
      </div>

      {value.primaryModel !== null && !primary && (
        <p className="field-error">节点上现在没有 {value.primaryModel}。{value.fallbackModel ? "起草时会改用备选。" : "没有备选，起草时他会被标为不可用。"}</p>
      )}

      {primary &&
        (primary.efforts.length === 0 ? (
          <p className="step-hint">{primary.displayName} 没有思考强度档位，会按模型自己的方式回答。</p>
        ) : (
          <>
            {OCCASIONS.map((o) => (
              <EffortSlider key={o.id} label={o.label} model={primary} value={value.effort[o.id]} onChange={(v) => setEffort(o.id, v)} />
            ))}
            {value.fallbackModel !== null && (
              <p className="step-hint">
                换成备选（{modelLabel(models, value.fallbackModel)}）时，上面的档位它没有的话，改用节点给它的默认档位，确认页会标出来。
              </p>
            )}
          </>
        ))}
    </div>
  );
}

/**
 * 一个场合的强度拉条（C-33b 照草案「模型和思考强度」）：上面一行场合名和「↺ 改回默认」，中间大字档位 + 说明，
 * 下面一条 44px 高的胶囊轨道，每档一个小圆点。最高一档整条变成流动的炫彩（江浩 2026-11-02 定），不放图标。
 * 档位顺序由节点给（从弱到强）；null = 跟随节点默认。
 */
function EffortSlider({
  label,
  model,
  value,
  onChange,
}: {
  label: string;
  model: ModelOption;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const known = value !== null && model.efforts.some((e) => e.id === value);
  const shown = known ? value : model.defaultEffort;
  const index = Math.max(0, model.efforts.findIndex((e) => e.id === shown));
  const level = model.efforts[index]!;
  const last = model.efforts.length - 1;
  const top = last > 0 && index === last;
  const id = useId();
  const note = !known ? (value === null ? "跟随节点默认" : `设的「${value}」这个模型没有，用节点默认`) : level.note;

  return (
    <div className="effort" data-top={top} style={{ "--pos": last === 0 ? 0 : index / last } as CSSProperties}>
      <div className="effort-head">
        <label htmlFor={id} className="effort-label">{label}</label>
        {known && value !== model.defaultEffort && (
          <button type="button" className="effort-reset" aria-label="改回节点默认" title="改回节点默认" onClick={() => onChange(null)}>
            ↺
          </button>
        )}
      </div>
      <div className="effort-level">
        <span className="effort-value" key={level.id}>{level.displayName}</span>
        {note && <small>{note}</small>}
      </div>
      <div className="effort-track">
        <span className="effort-fill" aria-hidden="true" />
        <span className="effort-dots" aria-hidden="true">
          {model.efforts.map((e, i) => <i key={e.id} data-on={i <= index || undefined} />)}
        </span>
        <input
          id={id}
          type="range"
          min={0}
          max={last}
          step={1}
          value={index}
          aria-valuetext={level.displayName}
          onChange={(e) => onChange(model.efforts[Number(e.target.value)]!.id)}
        />
      </div>
    </div>
  );
}
