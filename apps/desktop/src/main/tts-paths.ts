import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TtsConfig } from "./tts";

/**
 * 安装包里的语音合成资源（Python + IndexTTS2 模型）。
 *
 * 布局（electron-builder extraResources，见 apps/desktop/electron-builder.yml）：
 *
 *   <resources>/tts/python/python.exe          base Python 3.11（不含第三方依赖）
 *   <resources>/tts/site-packages/             venv 里的 site-packages（torch、indextts 依赖）
 *   <resources>/tts/index-tts/                 IndexTTS2 代码
 *   <resources>/tts/models/IndexTTS-2/         模型权重
 *   <resources>/tts/runner.py                  独立进程脚本
 *
 * 不用 venv 的 Scripts/python.exe（它靠 pyvenv.cfg 里的绝对 home），而是用 base python +
 * PYTHONPATH 指到自带的 site-packages，换机器 / 换安装目录都不会断。
 */
export interface BundledTtsPaths {
  python: string;
  script: string;
  modelDir: string;
  root: string;
  sitePackages: string;
}

const ENGINE_VERSION = "indextts2-2.0.0";

export function bundledTtsPaths(resourcesPath: string): BundledTtsPaths | null {
  const base = join(resourcesPath, "tts");
  const paths: BundledTtsPaths = {
    python: join(base, "python", "python.exe"),
    script: join(base, "runner.py"),
    modelDir: join(base, "models", "IndexTTS-2"),
    root: join(base, "index-tts"),
    sitePackages: join(base, "site-packages"),
  };
  if (![paths.python, paths.script, paths.modelDir, paths.root, paths.sitePackages].every((path) => existsSync(path))) {
    return null;
  }
  return paths;
}

/** 把自带的路径补成一份可用的配置；voices 沿用用户配置里的（模型本身不带音色） */
export function bundledTtsConfig(resourcesPath: string, voices: TtsConfig["voices"] = []): TtsConfig | null {
  const paths = bundledTtsPaths(resourcesPath);
  if (paths === null) return null;
  return {
    engine: "indextts2",
    engineVersion: ENGINE_VERSION,
    python: paths.python,
    script: paths.script,
    modelDir: paths.modelDir,
    root: paths.root,
    sitePackages: paths.sitePackages,
    voices,
  };
}
