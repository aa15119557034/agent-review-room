import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TtsConfig } from "./tts";

/**
 * 语音包（安装包之外单独分发的 zip）的定位与版本（#195 评审 B 方案）。
 *
 * 语音包 zip 解压后是 `tts/{python,site-packages,index-tts,models/IndexTTS-2,runtime.json}`，
 * **不含 runner.py**——runner.py 跟程序本体走，在 `<resources>/tts/runner.py`，
 * 这样打程序补丁时能更新它。
 *
 * 查找顺序（第一个「完整」的生效）：
 *   1. <安装目录>/tts                          （兼容：解压到安装目录）
 *   2. <LOCALAPPDATA>/评审室/tts               （推荐：装在安装目录外面，升级/卸载不会删）
 *   3. <resources>/tts                         （旧的内置布局）
 */
export const TTS_RUNTIME_VERSION = "1";
export const TTS_MODEL_VERSION = "indextts2-2.0.0";

export interface BundledTtsPaths {
  baseDir: string;
  python: string;
  script: string;
  modelDir: string;
  root: string;
  sitePackages: string;
  runtimeVersion: string;
  modelVersion: string;
}

export interface TtsBundleLookup {
  bundle: BundledTtsPaths | null;
  /** 找不到 / 缺东西 / 版本不对时的白话原因；能用的 bundle 时是 null */
  reason: string | null;
}

export interface TtsLookupInput {
  execPath: string;
  resourcesPath: string;
  /** 默认拿 process.env.LOCALAPPDATA；测试可以注入 */
  localAppData?: string;
}

function readVersion(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof raw.version === "string" ? raw.version : null;
  } catch {
    return null;
  }
}

function voiceDirs(base: string): { python: string; modelDir: string; root: string; sitePackages: string } {
  return {
    python: join(base, "python", "python.exe"),
    modelDir: join(base, "models", "IndexTTS-2"),
    root: join(base, "index-tts"),
    sitePackages: join(base, "site-packages"),
  };
}

/** 语音包可能的存放位置（按优先级） */
export function ttsCandidates(input: TtsLookupInput): string[] {
  const localAppData = input.localAppData ?? process.env.LOCALAPPDATA ?? "";
  const candidates = [join(dirname(input.execPath), "tts")];
  if (localAppData !== "") candidates.push(join(localAppData, "评审室", "tts"));
  candidates.push(join(input.resourcesPath, "tts"));
  return candidates;
}

export function findTtsBundle(input: TtsLookupInput): TtsBundleLookup {
  // runner.py 只跟程序本体走
  const script = join(input.resourcesPath, "tts", "runner.py");
  if (!existsSync(script)) {
    return { bundle: null, reason: "安装包缺少 runner.py（程序文件不完整），重新安装程序本体" };
  }

  let firstIncomplete: string[] | null = null;
  for (const baseDir of ttsCandidates(input)) {
    if (!existsSync(baseDir)) continue;
    const dirs = voiceDirs(baseDir);
    const missing = [dirs.python, dirs.sitePackages, dirs.root, dirs.modelDir]
      .filter((path) => !existsSync(path))
      .map((path) => path.slice(baseDir.length + 1));
    // 只有 runner.py 的目录（安装包自带的 resources/tts）不算语音包，直接跳过
    if (missing.length === 4) continue;
    if (missing.length > 0) {
      firstIncomplete ??= missing;
      continue;
    }
    const runtimeVersion = readVersion(join(baseDir, "runtime.json"));
    const modelVersion = readVersion(join(dirs.modelDir, "model.json"));
    if (runtimeVersion === null || modelVersion === null) {
      firstIncomplete ??= [runtimeVersion === null ? "runtime.json" : "models/IndexTTS-2/model.json"];
      continue;
    }
    if (runtimeVersion !== TTS_RUNTIME_VERSION || modelVersion !== TTS_MODEL_VERSION) {
      return {
        bundle: null,
        reason:
          "语音包版本不对（runtime=" +
          runtimeVersion +
          "，model=" +
          modelVersion +
          "；需要 runtime=" +
          TTS_RUNTIME_VERSION +
          "，model=" +
          TTS_MODEL_VERSION +
          "），重新解压对应的 zip",
      };
    }
    return {
      bundle: { baseDir, script, ...dirs, runtimeVersion, modelVersion },
      reason: null,
    };
  }

  if (firstIncomplete !== null) {
    return {
      bundle: null,
      reason: "语音包不完整（缺 " + firstIncomplete.join("、") + "），重新解压对应的 zip",
    };
  }
  return {
    bundle: null,
    reason:
      "语音包没装：把 tts-runtime-*.zip 和 tts-model-IndexTTS-2.zip 解压到 " +
      (input.localAppData ?? process.env.LOCALAPPDATA ?? "<LOCALAPPDATA>") +
      "\\评审室\\（会出现 tts 文件夹）",
  };
}

/** 把语音包补成一份可用的配置；voices 沿用用户配置里的（模型本身不带音色） */
export function bundledTtsConfig(bundle: BundledTtsPaths, voices: TtsConfig["voices"] = []): TtsConfig {
  return {
    engine: "indextts2",
    engineVersion: bundle.modelVersion,
    python: bundle.python,
    script: bundle.script,
    modelDir: bundle.modelDir,
    root: bundle.root,
    sitePackages: bundle.sitePackages,
    voices,
  };
}
