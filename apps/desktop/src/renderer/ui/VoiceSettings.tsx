import { useEffect, useState } from "react";
import type { VoiceOption, VoiceProfile } from "@room/schemas";
import { audioSrc } from "../lib/media";
import { useActions } from "./hooks";

/**
 * 秘书资料页里的「声音」（C-42c / C-43）。能选的声音来自本机语音合成引擎（voices.list），不写死。
 * 没选声音的秘书不合成语音，聊天里的「播放」会提示来这里选
 */
export function VoiceSettings({ value, onChange }: { value: VoiceProfile | null | undefined; onChange: (v: VoiceProfile | null) => void }) {
  const actions = useActions();
  const [voices, setVoices] = useState<VoiceOption[] | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void actions.chat.media.loadVoices().then((v) => alive && setVoices(v ?? null));
    return () => {
      alive = false;
    };
  }, [actions]);

  if (voices === undefined) return <p className="step-hint">正在读取能用的声音…</p>;
  if (voices === null) return <p className="step-hint">暂时读不到声音列表：这个版本可能还不支持语音，或者语音组件没装好。稍后再试。</p>;
  const current = value ?? null;
  const known = current ? voices.find((v) => v.id === current.voiceId) : undefined;
  return (
    <div className="voice-settings">
      <label>
        声音
        <select
          className="settings-input"
          value={current?.voiceId ?? ""}
          onChange={(e) => onChange(e.target.value ? { voiceId: e.target.value, speed: current?.speed ?? 1 } : null)}
        >
          <option value="">不用语音</option>
          {current && !known && <option value={current.voiceId}>{current.voiceId}（引擎里已经没有了）</option>}
          {voices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.displayName}
              {v.source === "reference" ? "（参考录音）" : ""}
            </option>
          ))}
        </select>
      </label>
      {current && (
        <label>
          语速 {current.speed.toFixed(1)}×
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={current.speed}
            onChange={(e) => onChange({ ...current, speed: Number(Number(e.target.value).toFixed(1)) })}
          />
        </label>
      )}
      {known?.sampleRef && <audio controls preload="none" src={audioSrc(known.sampleRef)} aria-label={`试听 ${known.displayName}`} />}
      {voices.length === 0 && <p className="step-hint">本机语音合成还没装好，暂时没有可选的声音。</p>}
      <p className="step-hint">语音只在这台电脑上合成，不上传。改了声音或语速，之前合成过的不再复用。</p>
    </div>
  );
}
