import { useEffect, useState } from "react";
import type { PackErrorCode, PackStatus } from "@room/schemas";
import { PACK_ERROR_TEXT } from "../lib/packs-actions";
import { useActions, useAppState } from "./hooks";

const STATE_TEXT: Record<PackStatus["state"], string> = {
  installed: "已安装",
  missing: "未安装",
  version_mismatch: "版本不对",
  incomplete: "文件不全",
};
const PHASE_TEXT = { extracting: "正在解压", checking: "正在检查", ready: "完成", failed: "失败" } as const;

function size(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/**
 * 设置页「导入包」（#209，契约 #214）。以后所有要导入的 zip / 文件夹（语音运行环境、模型、补丁……）都走这里：
 * 上面一个「导入」让程序按包里的 pack.json 自己认是哪个包；下面按登记表列出每个包的状态，
 * 可以对某一个包单独导入。选择框由主控机弹，这里不碰任何路径。包有哪些不写死，后端给什么就列什么。
 */
export function PacksSettings() {
  const actions = useActions();
  const packs = useAppState((s) => s.packs);
  const [lastError, setLastError] = useState<PackErrorCode | null>(null);
  useEffect(() => {
    void actions.packs.load();
  }, [actions]);
  const running = packs?.some((p) => p.progress?.phase === "extracting" || p.progress?.phase === "checking") ?? false;
  const importAny = async (mode: "zip" | "folder") => setLastError(await actions.packs.import(null, mode));

  return (
    <section className="settings-form" aria-labelledby="packs-title">
      <h2 className="settings-section" id="packs-title">导入包（语音、补丁等）</h2>
      <p className="step-hint">
        大文件包和补丁都从这里导入：选下载好的 zip 或解压后的文件夹，程序自己认是哪个包、解压、检查，不用手动放到哪个目录。
      </p>
      {packs !== null && (
        <div className="settings-actions">
          <button type="button" className="button-primary" disabled={running} onClick={() => void importAny("zip")}>
            导入 zip（自动识别）
          </button>
          <button type="button" className="button-outline" disabled={running} onClick={() => void importAny("folder")}>
            导入文件夹（自动识别）
          </button>
        </div>
      )}
      {lastError && (
        <p className="test-result" data-ok="false" role="alert">
          {PACK_ERROR_TEXT[lastError]}
        </p>
      )}
      {packs === null ? (
        <p className="step-hint">读取中…（后端还没有包导入功能时这里会一直空着）</p>
      ) : (
        <ul className="pack-list">
          {packs.map((p) => (
            <PackRow key={p.id} pack={p} onError={setLastError} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PackRow({ pack, onError }: { pack: PackStatus; onError: (e: PackErrorCode | null) => void }) {
  const actions = useActions();
  const prog = pack.progress;
  const running = prog?.phase === "extracting" || prog?.phase === "checking";
  const pct = prog && prog.totalBytes ? Math.min(100, Math.round((prog.doneBytes / prog.totalBytes) * 100)) : null;
  const go = async (mode: "zip" | "folder") => onError(await actions.packs.import(pack.id, mode));
  const needs = pack.state !== "installed" || prog?.phase === "failed";
  return (
    <li className="pack" data-state={pack.state}>
      <div className="pack-head">
        <strong>{pack.label}</strong>
        <span className="pack-state">{STATE_TEXT[pack.state]}</span>
      </div>
      <p className="step-hint">
        {pack.description}
        {pack.version && ` · 版本 ${pack.version}`}
        {pack.state === "version_mismatch" && pack.expectedVersion && `（程序需要 ${pack.expectedVersion}）`}
        {pack.totalBytes !== null && ` · ${size(pack.totalBytes)}`}
      </p>
      {pack.path && <p className="step-hint">位置：<code>{pack.path}</code></p>}
      {pack.missing.length > 0 && <p className="field-error">缺少：{pack.missing.join("、")}</p>}
      {prog && prog.phase !== "failed" && (
        <div role="status">
          <progress max={100} value={pct ?? undefined} aria-label={`${pack.label}${PHASE_TEXT[prog.phase]}`} />
          <span className="step-hint">
            {" "}{PHASE_TEXT[prog.phase]}
            {pct !== null && ` ${pct}%`}
          </span>
        </div>
      )}
      {prog?.phase === "failed" && prog.error && (
        <p className="test-result" data-ok="false" role="alert">{PACK_ERROR_TEXT[prog.error]}</p>
      )}
      <div className="settings-actions">
        <button type="button" className={needs ? "button-outline" : "button-quiet"} disabled={running} onClick={() => void go("zip")}>
          {needs ? "导入 zip" : "换一个包（zip）"}
        </button>
        {needs && (
          <button type="button" className="button-outline" disabled={running} onClick={() => void go("folder")}>
            导入文件夹
          </button>
        )}
      </div>
    </li>
  );
}
