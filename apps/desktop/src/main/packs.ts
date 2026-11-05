import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import yauzl from "yauzl";
import type { CommandRequest, ControlEvent, PackErrorCode, PackId, PackProgress, PackStatus, Packs } from "@room/schemas";
import { TTS_MODEL_VERSION, TTS_RUNTIME_VERSION } from "./tts-paths";

/**
 * 包的应用内导入（#209，契约 #214）。
 *
 * - packs.list：按登记表扫描安装目录 / LOCALAPPDATA / resources 下的 tts 目录，报 installed / missing / incomplete / version_mismatch。
 * - packs.import：main 弹选择框；zip 或文件夹 → 暂存到 staging → 读 pack.json 认包 → 校验必需项和版本 → 原子移动到 tts 目录。
 * - 进度与结果走 packs.updated；失败给原因码，不抛原始异常。
 *
 * 包目录布局：zip 根（或它下面一层 tts/）里放 pack.json {id, version} 和包内容：
 *   tts-runtime: python/ site-packages/ index-tts/ runtime.json
 *   tts-model:   models/IndexTTS-2/（含 model.json）
 */
export interface PackDefinition {
  id: PackId;
  label: string;
  description: string;
  expectedVersion: string | null;
  required: readonly string[];
  versionFile: string;
}

export const PACK_REGISTRY: readonly PackDefinition[] = [
  {
    id: "tts-runtime",
    label: "语音运行环境",
    description: "语音合成用的 Python、依赖和 IndexTTS2 代码",
    expectedVersion: TTS_RUNTIME_VERSION,
    required: ["python", "site-packages", "index-tts"],
    versionFile: "runtime.json",
  },
  {
    id: "tts-model",
    label: "语音模型",
    description: "语音合成的 IndexTTS2 模型文件",
    expectedVersion: TTS_MODEL_VERSION,
    required: [join("models", "IndexTTS-2")],
    versionFile: join("models", "IndexTTS-2", "model.json"),
  },
];

export interface PackDialog {
  showOpenDialog(options: {
    title: string;
    properties: readonly ("openFile" | "openDirectory")[];
    filters?: readonly { name: string; extensions: readonly string[] }[];
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export interface PacksServiceDeps {
  dialog: PackDialog;
  installDir: string;
  resourcesPath: string;
  localAppData: string | undefined;
  emit: (event: ControlEvent) => void;
}

class PackImportError extends Error {
  constructor(
    readonly code: PackErrorCode,
    readonly packId: PackId | null,
    message: string,
  ) {
    super(message);
    this.name = "PackImportError";
  }
}

const REPORT_INTERVAL_MS = 150;
const ZIP_PREFIX = "tts/";

function readVersionFile(path: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof raw.version === "string" ? raw.version : null;
  } catch {
    return null;
  }
}

function readManifest(path: string): { id?: string; version?: string } | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { id?: string; version?: string };
  } catch {
    return null;
  }
}

function copyTree(source: string, destination: string, onBytes: (bytes: number) => void): void {
  const info = statSync(source);
  if (info.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(source)) copyTree(join(source, name), join(destination, name), onBytes);
    return;
  }
  mkdirSync(dirname(destination), { recursive: true });
  const data = readFileSync(source);
  writeFileSync(destination, data);
  onBytes(data.byteLength);
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error !== null || zip === undefined) reject(error ?? new Error("zip open failed"));
      else resolve(zip);
    });
  });
}

export class PacksService {
  #busy = false;
  #lastReport = 0;
  readonly #progress = new Map<PackId, PackProgress>();

  constructor(private readonly deps: PacksServiceDeps) {}

  list(): Packs {
    return PACK_REGISTRY.map((definition) => this.#status(definition));
  }

  #targetBase(): string {
    return this.deps.localAppData !== undefined && this.deps.localAppData !== ""
      ? join(this.deps.localAppData, "评审室", "tts")
      : join(this.deps.installDir, "tts");
  }

  #bases(): string[] {
    return [join(this.deps.installDir, "tts"), this.#targetBase(), join(this.deps.resourcesPath, "tts")];
  }

  #findBase(definition: PackDefinition): string | null {
    for (const base of this.#bases()) {
      if (definition.required.some((item) => existsSync(join(base, item)))) return base;
      if (existsSync(join(base, definition.versionFile))) return base;
    }
    return null;
  }

  #status(definition: PackDefinition): PackStatus {
    const base = this.#findBase(definition);
    const progress = this.#progress.get(definition.id) ?? null;
    if (base === null) {
      return {
        id: definition.id,
        label: definition.label,
        description: definition.description,
        state: "missing",
        version: null,
        expectedVersion: definition.expectedVersion,
        path: null,
        missing: [],
        totalBytes: null,
        progress,
      };
    }
    const missing = definition.required.filter((item) => !existsSync(join(base, item)));
    const version = readVersionFile(join(base, definition.versionFile));
    const state: PackStatus["state"] =
      missing.length > 0
        ? "incomplete"
        : version === null
          ? "incomplete"
          : definition.expectedVersion !== null && version !== definition.expectedVersion
            ? "version_mismatch"
            : "installed";
    return {
      id: definition.id,
      label: definition.label,
      description: definition.description,
      state,
      version,
      expectedVersion: definition.expectedVersion,
      path: base,
      missing: missing.length > 0 ? missing : version === null ? [definition.versionFile] : [],
      totalBytes: null,
      progress,
    };
  }

  async import(command: CommandRequest<"packs.import">): Promise<{
    cancelled: boolean;
    packId: PackId | null;
    error: PackErrorCode | null;
    packs: Packs;
  }> {
    if (this.#busy) {
      return { cancelled: false, packId: command.id, error: "PACK_BUSY", packs: this.list() };
    }
    this.#busy = true;
    try {
      const picked = await this.deps.dialog.showOpenDialog({
        title: command.mode === "zip" ? "选择包（zip）" : "选择包（文件夹）",
        properties: command.mode === "zip" ? ["openFile"] : ["openDirectory"],
        ...(command.mode === "zip" ? { filters: [{ name: "zip", extensions: ["zip"] }] } : {}),
      });
      const source = picked.filePaths[0];
      if (picked.canceled || source === undefined) {
        return { cancelled: true, packId: null, error: null, packs: this.list() };
      }
      const staged = command.mode === "zip" ? await this.#stageZip(source, command.id) : this.#stageFolder(source, command.id);
      const definition = staged.definition;
      this.#progress.set(definition.id, { phase: "checking", doneBytes: staged.bytes, totalBytes: staged.bytes, error: null });
      this.#publish();
      this.#validate(definition, staged.root);
      this.#install(staged.root, this.#targetBase());
      this.#progress.delete(definition.id);
      this.#publish();
      return { cancelled: false, packId: definition.id, error: null, packs: this.list() };
    } catch (error) {
      const code: PackErrorCode =
        error instanceof PackImportError ? error.code : (error as { code?: string }).code === "ENOSPC" ? "PACK_NO_SPACE" : "PACK_ARCHIVE_INVALID";
      const packId = error instanceof PackImportError ? error.packId : command.id;
      if (packId !== null) this.#progress.set(packId, { phase: "failed", doneBytes: 0, totalBytes: null, error: code });
      this.#publish();
      return { cancelled: false, packId, error: code, packs: this.list() };
    } finally {
      this.#busy = false;
    }
  }

  #publish(): void {
    this.deps.emit({ type: "packs.updated", packs: this.list() });
  }

  #definitionById(id: PackId | null): PackDefinition {
    if (id === null) throw new PackImportError("PACK_UNKNOWN", null, "没有指定包");
    const found = PACK_REGISTRY.find((item) => item.id === id);
    if (found === undefined) throw new PackImportError("PACK_UNKNOWN", null, "未知的包 id");
    return found;
  }

  #manifestOf(staging: string, requested: PackId | null): PackDefinition {
    const manifestPath = join(staging, "pack.json");
    const manifest = existsSync(manifestPath) ? readManifest(manifestPath) : null;
    const id = manifest?.id ?? null;
    if (requested === null && id === null) {
      throw new PackImportError("PACK_UNKNOWN", null, "压缩包里没有 pack.json，认不出是哪个包");
    }
    if (id !== null && requested !== null && id !== requested) {
      throw new PackImportError("PACK_UNKNOWN", id as PackId, "压缩包里的包和选的不一致");
    }
    return this.#definitionById((requested ?? id) as PackId);
  }

  async #stageZip(source: string, requested: PackId | null): Promise<{ definition: PackDefinition; root: string; bytes: number }> {
    const staging = this.#stagingDir();
    let bytes = 0;
    try {
      const zip = await openZip(source);
      await new Promise<void>((resolve, reject) => {
        zip.on("entry", (entry: yauzl.Entry) => {
          if (entry.fileName.endsWith("/")) {
            zip.readEntry();
            return;
          }
          const name = entry.fileName.startsWith(ZIP_PREFIX) ? entry.fileName.slice(ZIP_PREFIX.length) : entry.fileName;
          if (name === "" || name.includes("..")) {
            reject(new PackImportError("PACK_ARCHIVE_INVALID", requested, "压缩包里有不安全的路径"));
            return;
          }
          const destination = join(staging, name);
          mkdirSync(dirname(destination), { recursive: true });
          zip.openReadStream(entry, (error, stream) => {
            if (error !== null || stream === undefined) {
              reject(error ?? new Error("zip read failed"));
              return;
            }
            const out = createWriteStream(destination);
            stream.on("data", (chunk: Buffer) => {
              bytes += chunk.byteLength;
              this.#report(requested, bytes);
            });
            stream.on("error", reject);
            out.on("error", reject);
            out.on("close", () => zip.readEntry());
            stream.pipe(out);
          });
        });
        zip.on("end", resolve);
        zip.on("error", reject);
        zip.readEntry();
      });
      const definition = this.#manifestOf(staging, requested);
      return { definition, root: staging, bytes };
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  #stageFolder(source: string, requested: PackId | null): { definition: PackDefinition; root: string; bytes: number } {
    const root = existsSync(join(source, "pack.json"))
      ? source
      : existsSync(join(source, "tts", "pack.json"))
        ? join(source, "tts")
        : source;
    const definition = this.#manifestOf(root, requested);
    const staging = this.#stagingDir();
    let bytes = 0;
    for (const name of readdirSync(root)) {
      if (name === "pack.json") continue;
      copyTree(join(root, name), join(staging, name), (count) => {
        bytes += count;
        this.#report(definition.id, bytes);
      });
    }
    return { definition, root: staging, bytes };
  }

  #report(id: PackId | null, doneBytes: number): void {
    if (id === null) return;
    const now = Date.now();
    this.#progress.set(id, { phase: "extracting", doneBytes, totalBytes: null, error: null });
    if (now - this.#lastReport < REPORT_INTERVAL_MS) return;
    this.#lastReport = now;
    this.#publish();
  }

  #stagingDir(): string {
    const base = this.#targetBase();
    const staging = join(base, ".staging-" + Date.now());
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    return staging;
  }

  #validate(definition: PackDefinition, root: string): void {
    const missing = definition.required.filter((item) => !existsSync(join(root, item)));
    if (missing.length > 0) throw new PackImportError("PACK_INCOMPLETE", definition.id, "包不完整：" + missing.join("、"));
    const version = readVersionFile(join(root, definition.versionFile));
    if (version === null) throw new PackImportError("PACK_INCOMPLETE", definition.id, "缺少版本文件 " + definition.versionFile);
    if (definition.expectedVersion !== null && version !== definition.expectedVersion) {
      throw new PackImportError("PACK_VERSION_MISMATCH", definition.id, "版本不对：" + version);
    }
  }

  #install(root: string, base: string): void {
    mkdirSync(base, { recursive: true });
    for (const name of readdirSync(root)) {
      if (name === "pack.json") continue;
      const destination = join(base, name);
      rmSync(destination, { recursive: true, force: true });
      try {
        renameSync(join(root, name), destination);
      } catch {
        copyTree(join(root, name), destination, () => undefined);
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}
