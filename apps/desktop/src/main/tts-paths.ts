import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TtsConfig } from "./tts";

/**
 * 语音包（安装包之外单独分发的 zip）的定位与版本（#195 评审 B 方案）。
 *
 * 布局：把 `tts-runtime-<版本>.zip` 和 `tts-model-IndexTTS-2.zip` 解压到安装目录，得到
 *
 *   <安装目录>/tts/python/python.exe
 *   <安装目录>/tts/site-packages/
 *   <安装目录>/tts/index-tts/
 *   <安装目录>/tts/models/IndexTTS-2/
 *   <安装目录>/tts/runtime.json              {"version":"1"}
 *   <安装目录>/tts/models/IndexTTS-2/model.json {"version":"indextts2-2.0.0"}
 *   <安装目录>/tts/runner.py                 （安装包自带）
 *
 * 兼容旧的 <resources>/tts（安装包内置）布局。
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

function readVersion(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof raw.version === "string" ? raw.version : null;
  } catch {
    return null;
  }
}

function required(base: string): { python: string; script: string; modelDir: string; root: string; sitePackages: string } {
  return {
    python: join(base, "python", "python.exe"),
    script: join(base, "runner.py"),
    modelDir: join(base, "models", "IndexTTS-2"),
    root: join(base, "index-tts"),
    sitePackages: join(base, "site-packages"),
  };
}

/**
 * 找语音包目录：优先 <安装目录>/tts（exe 旁边），再退到 <resources>/tts（安装包内置的旧布局）。
 * 返回第一个「目录存在」的候选；内容是否齐全由调用方检查。
 */
export function findTtsBase(execPath: string, resourcesPath: string): { baseDir: string; missing: string[] } | null {
  const candidates = [join(dirname(execPath), "tts"), join(resourcesPath, "tts")];
  for (const baseDir of candidates) {
    if (!existsSync(baseDir)) continue;
    const paths = required(baseDir);
    const missing = [paths.python, paths.script, paths.modelDir, paths.root, paths.sitePackages].filter(
      (path) => !existsSync(path),
    );
    return { baseDir, missing };
  }
  return null;
}

export function findTtsBundle(execPath: string, resourcesPath: string): TtsBundleLookup {
  const found = findTtsBase(execPath, resourcesPath);
  if (found === null) {
    return {
      bundle: null,
      reason: "语音包没装：把 tts-runtime-*.zip 和 tts-model-IndexTTS-2.zip 解压到安装目录（会出现 tts 文件夹）",
    };
  }
  if (found.missing.length > 0) {
    const names = found.missing.map((path) => path.slice(found.baseDir.length + 1)).join("、");
    return { bundle: null, reason: "语音包不完整（缺 " + names + "），重新解压对应的 zip" };
  }
  const paths = required(found.baseDir);
  const runtimeVersion = readVersion(join(found.baseDir, "runtime.json"));
  const modelVersion = readVersion(join(paths.modelDir, "model.json"));
  if (runtimeVersion === null) {
    return { bundle: null, reason: "语音包缺少 runtime.json（版本文件），重新解压 tts-runtime-*.zip" };
  }
  if (modelVersion === null) {
    return { bundle: null, reason: "语音包缺少 models/IndexTTS-2/model.json（版本文件），重新解压 tts-model-IndexTTS-2.zip" };
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
    bundle: { baseDir: found.baseDir, ...paths, runtimeVersion, modelVersion },
    reason: null,
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
