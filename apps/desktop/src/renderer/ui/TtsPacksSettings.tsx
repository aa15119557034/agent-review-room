import { useEffect } from "react";
import type { TtsPackKind, TtsPackStatus } from "@room/schemas";
import { TTS_PACK_ERROR_TEXT } from "../lib/tts-packs-actions";
import { useActions, useAppState } from "./hooks";

const LABEL: Record<TtsPackKind, { name: string; what: string }> = {
  runtime: { name: "运行环境", what: "语音合成用的 Python 和依赖" },
  model: { name: "模型", what: "语音合成的模型文件" },
};

const STATE_TEXT: Record<TtsPackStatus["state"], string> = {
  installed: "已安装",
  missing: "未安装",
  version_mismatch: "版本不对",
  incomplete: "文件不全",
};

function gb(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

const PHASE_TEXT = { extracting: "正在解压", checking: "正在检查", ready: "完成", failed: "失败" } as const;

/**
 * 设置页「语音包」（#209，契约 #212）：两个包各一行，显示状态、版本、大小、位置，
 * 未安装 / 不对的行给「导入 zip」「导入文件夹」。选择框由主控机弹，这里不碰任何路径。
 */
export function TtsPacksSettings() {
  const actions = useActions();
  const packs = useAppState((s) => s.ttsPacks);
  useEffect(() => {
    void actions.ttsPacks.load();
  }, [actions]);

  return (
    <section className="settings-form" aria-labelledby="tts-packs-title">
      <h2 className="settings-section" id="tts-packs-title">语音包</h2>
      <p className="step-hint">
        语音合成要两个大文件包。从下载好的 zip 或解压后的文件夹导入，程序会自己解压、检查，不用手动放到哪个目录。
      </p>
      {packs === null ? (
        <p className="step-hint">读取中…（后端还没有语音包功能时这里会一直空着）</p>
      ) : (
        <ul className="tts-pack-list">
          {packs.map((p) => (
            <PackRow key={p.kind} pack={p} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PackRow({ pack }: { pack: TtsPackStatus }) {
  const actions = useActions();
  const prog = pack.progress;
  const running = prog?.phase === "extracting" || prog?.phase === "checking";
  const label = LABEL[pack.kind];
  const pct = prog && prog.totalBytes ? Math.min(100, Math.round((prog.doneBytes / prog.totalBytes) * 100)) : null;
  return (
    <li className="tts-pack" data-state={pack.state}>
      <div className="tts-pack-head">
        <strong>{label.name}</strong>
        <span className="tts-pack-state">{STATE_TEXT[pack.state]}</span>
      </div>
      <p className="step-hint">
        {label.what}
        {pack.version && ` · 版本 ${pack.version}`}
        {pack.state === "version_mismatch" && `（程序需要 ${pack.expectedVersion}）`}
        {pack.totalBytes !== null && ` · ${gb(pack.totalBytes)}`}
      </p>
      {pack.path && <p className="step-hint">位置：<code>{pack.path}</code></p>}
      {pack.missing.length > 0 && <p className="field-error">缺少：{pack.missing.join("、")}</p>}
      {prog && prog.phase !== "failed" && (
        <div role="status">
          <progress max={100} value={pct ?? undefined} aria-label={`${label.name}${PHASE_TEXT[prog.phase]}`} />
          <span className="step-hint">
            {" "}{PHASE_TEXT[prog.phase]}
            {pct !== null && ` ${pct}%`}
          </span>
        </div>
      )}
      {prog?.phase === "failed" && prog.error && (
        <p className="test-result" data-ok="false" role="alert">{TTS_PACK_ERROR_TEXT[prog.error]}</p>
      )}
      {pack.state !== "installed" || prog?.phase === "failed" ? (
        <div className="settings-actions">
          <button type="button" className="button-outline" disabled={running} onClick={() => void actions.ttsPacks.import(pack.kind, "zip")}>
            导入 zip
          </button>
          <button type="button" className="button-outline" disabled={running} onClick={() => void actions.ttsPacks.import(pack.kind, "folder")}>
            导入文件夹
          </button>
        </div>
      ) : (
        <div className="settings-actions">
          <button type="button" className="button-quiet" disabled={running} onClick={() => void actions.ttsPacks.import(pack.kind, "zip")}>
            换一个包（zip）
          </button>
        </div>
      )}
    </li>
  );
}
