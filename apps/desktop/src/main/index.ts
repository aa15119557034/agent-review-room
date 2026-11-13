import { WorkspaceService } from "./workspace";
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, safeStorage, shell } from "electron";
import { dirname, join, isAbsolute } from "node:path";
import { openDatabase, repairInterruptedRuns, WriteQueue } from "@room/db";
import { HttpRemoteAgentAdapter } from "@room/remote-client";
import { IMAGE_URL_SCHEME, AUDIO_URL_SCHEME, IPC_CHANNELS, type ControlEvent } from "@room/schemas";
import { ChatService } from "./chat";
import { GithubSyncService } from "./github";
import { NotesService } from "./notes";
import { DiscussionService } from "./discussion";
import { createDispatcher } from "./ipc";
import { ComfyUiClient, loadComfyUiConfigFile } from "./comfyui";
import { MediaService } from "./media";
import { MediaJobsService } from "./media-jobs";
import { createAudioProtocolHandler, createImageProtocolHandler, MediaStore } from "./media-store";
import { loadAsrConfigFile, SidecarTranscriber } from "./voice-transcriber";
import { MediaVoiceStore } from "./voice-store";
import { VoiceService } from "./voice";
import { migrateLegacyReviewerNode, NodeService, resolveRunTarget } from "./nodes";
import { RunOrchestrator } from "./orchestrator";
import { Repository } from "./repository";
import { SettingsStore } from "./settings";
import { loadTtsConfigFile, TtsRunner, voiceOptionsOf } from "./tts";
import { PacksService } from "./packs";
import { runCliIfRequested } from "./cli";
import { bundledTtsConfig, findTtsBundle } from "./tts-paths";

/**
 * Electron 主进程入口（D-07）。
 *
 * 启动顺序对齐 V0.4 §32：初始化 DB → 修复中断的 run → 起 IPC → 开窗口。
 * Token 只在主进程解密使用，绝不进 renderer / SQLite / 日志。
 */

// 验收/受限机器：用环境变量把数据目录指到可写位置（这台机器写 %APPDATA% 会被拦）
const CLI_FLAGS = ["--self-test", "--import-local-token", "--set-voice", "--tts-test"];
const cliRequested = process.argv.some((arg) => CLI_FLAGS.includes(arg));
const dataOverride = process.env.AGENT_REVIEW_ROOM_DATA;
if (dataOverride !== undefined && dataOverride.trim() !== "") {
  try {
    mkdirSync(dataOverride, { recursive: true });
    app.setPath("userData", dataOverride);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cliRequested) {
      console.error("[startup] 数据目录覆盖失败：" + message);
      process.exit(1);
    }
    console.warn("[startup] 数据目录覆盖失败：", message);
  }
}

// D-36b：room-image:// / D-34b：room-audio:// 必须在 app ready 之前登记；只读、不导航、不当页面打开
protocol.registerSchemesAsPrivileged([
  {
    scheme: IMAGE_URL_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
  {
    scheme: AUDIO_URL_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
]);

const isDev = !app.isPackaged;

function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? "#131b1f" : "#e9eeec";
}

let mainWindow: BrowserWindow | null = null;
const defaultDataDirectory = app.getPath("userData");
const dataLocationFile = join(defaultDataDirectory, "active-data.json");

function broadcast(event: ControlEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(IPC_CHANNELS.event, event);
  }
}

function createWindow(): void {
  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];

  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: "Agent 评审室",
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow = window;
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    const allowed = devServerUrl !== undefined ? url.startsWith(devServerUrl) : url.startsWith("file://");
    if (!allowed) event.preventDefault();
  });

  if (isDev && devServerUrl !== undefined) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath("userData");
  const db = openDatabase(join(userData, "room.db"));
  const queue = new WriteQueue();
  const repo = new Repository(db, queue);

  // D-36b：图片本体和引用表；renderer 用 room-image://<ref> 显示，main 只按记录映射到文件
  const mediaStore = new MediaStore(join(userData, "images"), join(userData, "files"), join(userData, "audio"), db);
  protocol.handle(IMAGE_URL_SCHEME, createImageProtocolHandler(mediaStore));

  // D-34b：录音本体 + 本地转写（Python sidecar）。没配 asr.json 时明确说「转写不可用」，不假装成功
  const asr = loadAsrConfigFile(join(userData, "asr.json"), app.isPackaged ? join(process.resourcesPath, "python", "transcribe.py") : join(app.getAppPath(), "python", "transcribe.py"));
  if (asr.config === null) console.warn(`[voice] ${asr.problem}； chat.voice.import 会明确拒绝`);
  const transcriber = asr.config === null ? null : new SidecarTranscriber(asr.config);
  // #137 评审第 1 条：录音字节并入 MediaStore（D-37b），room-audio:// 只有底部那一个处理器
  const voiceStore = new MediaVoiceStore(
    mediaStore,
    db,
    async (path) => {
      if (transcriber === null) throw new Error("本地转写还没配好");
      return transcriber.probe(path);
    },
    () => new Date().toISOString(),
  );
  const voice = new VoiceService({
    db,
    store: voiceStore,
    transcriber,
    emit: broadcast,
    now: () => new Date().toISOString(),
  });
  const repairedVoice = cliRequested ? 0 : voice.repairInterrupted();
  if (repairedVoice > 0) console.warn(`[voice] 收尾了 ${repairedVoice} 条上次没转完的录音（应用重启，转写中断）`);

  // D-34a：选文件 / 表情用的对话框。renderer 只拿 ref，拿不到路径
  const comfyConfig = loadComfyUiConfigFile(join(userData, "comfyui.json"));
  if (comfyConfig === null) console.warn("[comfyui] 没有配置 userData/comfyui.json，本机画图不可用");
  const comfyClient = comfyConfig === null ? null : new ComfyUiClient(comfyConfig);
  // D-37b：语音合成的独立进程（配置在 userData/tts.json；没配置就是 null，「播放」会明确报没配好）
  const configuredTts = loadTtsConfigFile(join(userData, "tts.json"));
  // 语音包（单独 zip 解压到安装目录）：运行时装在 exe 旁边的 tts/，或旧的 resources/tts
  const bundleLookup = app.isPackaged
    ? findTtsBundle({
        execPath: process.execPath,
        resourcesPath: process.resourcesPath,
        localAppData: process.env.LOCALAPPDATA,
      })
    : null;
  if (bundleLookup !== null) {
    if (bundleLookup.bundle === null) {
      console.warn("[tts] " + (bundleLookup.reason ?? "语音包不可用"));
    } else {
      console.info(
        "[tts] 语音包：" +
          bundleLookup.bundle.baseDir +
          "（runtime=" +
          bundleLookup.bundle.runtimeVersion +
          "，model=" +
          bundleLookup.bundle.modelVersion +
          "）",
      );
    }
  }
  const bundled =
    bundleLookup?.bundle === null || bundleLookup === null
      ? null
      : bundledTtsConfig(bundleLookup.bundle, configuredTts?.voices);
  // 语音包优先：tts.json 只提供音色；没有语音包时才用用户自己配的引擎
  const ttsConfig =
    bundled ??
    (configuredTts !== null && existsSync(configuredTts.python) && existsSync(configuredTts.script) ? configuredTts : null);
  if (ttsConfig === null) console.warn("[tts] 没有配置 userData/tts.json，语音合成不可用");
  const ttsTempDir = join(userData, "tmp");
  const ttsRunner =
    ttsConfig === null ? null : new TtsRunner({ ...ttsConfig, tempDir: ttsTempDir });
  protocol.handle(AUDIO_URL_SCHEME, createAudioProtocolHandler(mediaStore));
  const jobs = new MediaJobsService({
    db,
    queue,
    store: mediaStore,
    emit: broadcast,
    comfy: () => comfyClient,
    tts: () => ttsRunner,
    agentOf: (agentId) => repo.getAgent(agentId),
    now: () => new Date().toISOString(),
  });

  // 上次崩掉 / 被强杀留下的画图任务统一收尾（契约 media.ts：不留「生成中」）
  const repairedMedia = cliRequested ? 0 : await jobs.repairInterrupted();
  if (repairedMedia > 0) console.warn(`[media] 收尾了 ${repairedMedia} 个上次没跑完的画图任务`);

  const media = new MediaService({
    db,
    store: mediaStore,
    now: () => new Date().toISOString(),
    openFileDialog: async (options) => {
      const result = await dialog.showOpenDialog({
        title: options.title,
        properties: ["openFile"],
        filters: options.filters,
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    },
  });

  // §32 第 3 步：上次崩溃留下的 QUEUED / STARTING / RUNNING 统一标成 interrupted
  const repaired = cliRequested ? { repaired: [] as unknown[] } : await repairInterruptedRuns(db, queue);

  const settings = new SettingsStore(join(userData, "settings.json"), safeStorage);
  // 旧设置里的 Reviewer 节点 -> user-pc（幂等）：多节点有了 Token 存储，单次评审照旧
  migrateLegacyReviewerNode(db, settings);

  let discussion: DiscussionService | null = null;

  // C-46 / D-46a：项目笔记（存版本 + 从回答里切 room-note + 拼 Prompt 用）
  const github = new GithubSyncService({ db, settings, emit: broadcast });
  if (!cliRequested) github.start();
  const notes = new NotesService({
    db,
    queue,
    emit: broadcast,
    knownAgents: () => repo.listAgents().map((agent) => agent.id),
    github,
  });

  const orchestrator = new RunOrchestrator({
    db,
    queue,
    emit: broadcast,
    notes,
    getRun: (runId) => db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as never,
    // 讨论室的收尾要推 message.created / turn.updated / round.updated …，交给 DiscussionService
    onDiscussionSettled: (settlement) => discussion?.settled(settlement),
    adapterFactory: async (run) => {
      // 讨论室：agent -> node -> 地址与 Token；Phase 0 的评审 Run 沿用原来的 Reviewer 设置
      // C-40 的 model 也在 target 里：和 e2e harness 共用 nodes.ts 的同一份查询
      const target = resolveRunTarget(db, settings, run);
      const adapter = new HttpRemoteAgentAdapter({
        nodeId: target.nodeId,
        baseUrl: target.baseUrl,
        profileId: target.profileId,
        token: target.token,
        ...(target.model === undefined ? {} : { model: target.model }),
        heartbeatTimeoutMs: 15_000,
        reconnectGraceMs: 30_000,
        requestTimeoutMs: 10_000,
      });
      await adapter.initialize();
      return adapter;
    },
  });

  discussion = new DiscussionService({
    db,
    queue,
    repo,
    settings,
    orchestrator,
    voices: () => (ttsConfig === null ? [] : voiceOptionsOf(ttsConfig)),
    emit: broadcast,
    notes,
  });

  const nodes = new NodeService({ repo, settings });

  // D-31b：聊天服务。Run 走各自的聊天 profile（只读、无工具），和讨论室的 Run 分开
  const chat = new ChatService({
    db,
    queue,
    repo,
    settings,
    emit: broadcast,
    notes,
    readFileText: (ref) => mediaStore.readFileText(ref),
    // C-42a / X-34b：带图聊天要读图片本体（字节只在 main 里，不进 renderer）
    readImage: (ref) => mediaStore.readImage(ref),
    cancelMediaJobs: async (messageIds) => {
      await jobs.cancelBySourceMessageIds(messageIds);
    },
    // D-39：沉浸模式的自动画图 / 自动语音（authorization = immersive）
    drawMedia: async (source, draw, intentHash) => {
      await jobs.start({ prompt: draw.prompt, size: draw.size, backend: "auto" }, source, false, {
        authorization: "immersive",
        intentHash,
      });
    },
    speakMedia: async (source, intentHash) => {
      await jobs.play(source, { authorization: "immersive", intentHash });
    },
    stopMedia: async (scope) => {
      await jobs.stop(scope, "immersive_off");
    },
    failSpeech: async (source, intentHash, message) => {
      await jobs.failImmersiveSpeech(source, intentHash, message);
    },
    // D-37b：「用语音回」的回答落库后自动排语音合成（命中缓存时任务立刻成功）
    speakAnswer: async (source) => {
      await jobs.play(source, { authorization: "reply_as_voice" });
    },
    adapterFactory: async (target) => {
      const adapter = new HttpRemoteAgentAdapter({
        nodeId: target.nodeId,
        baseUrl: target.baseUrl,
        profileId: target.profileId,
        token: target.token,
        ...(target.model === undefined ? {} : { model: target.model }),
        heartbeatTimeoutMs: 15_000,
        reconnectGraceMs: 30_000,
        requestTimeoutMs: 10_000,
      });
      await adapter.initialize();
      return adapter;
    },
  });
  const repairedChat = cliRequested ? 0 : await chat.repairInterrupted();
  if (!cliRequested) await chat.repairPendingImmersive();

  const workspace = new WorkspaceService({
    db, queue, userData, version: app.getVersion(), revision: process.env["ROOM_BUILD_SHA"] ?? "development",
    confirmSwitch: async (target) => (await dialog.showMessageBox({type:"question",buttons:["取消","切换并重启"],defaultId:0,cancelId:0,title:"切换资料",message:target?"将打开恢复副本，原资料继续保留。节点凭据和本机媒体配置需要重新配置。":"将切回原资料目录，恢复副本继续保留。"})).response===1,
    activateDirectory: (target) => {
      if(target===null){rmSync(dataLocationFile,{force:true});}
      else {mkdirSync(defaultDataDirectory,{recursive:true});writeFileSync(dataLocationFile+".tmp",JSON.stringify({directory:target}),"utf8");renameSync(dataLocationFile+".tmp",dataLocationFile);}
      setTimeout(()=>{app.relaunch();app.quit();},250);
    },
    chooseDirectory: async (title) => { const result = await dialog.showOpenDialog({title, properties:["openDirectory", "createDirectory"]}); return result.canceled ? null : result.filePaths[0] ?? null; },
    chooseSaveFile: async (title, defaultPath) => { const result = await dialog.showSaveDialog({title, defaultPath, filters:[{name:"JSON",extensions:["json"]}]}); return result.canceled ? null : result.filePath ?? null; },
    checks: async () => {
      const checkedAt = new Date().toISOString();
      const nodeChecks = await Promise.all(nodes.list().slice(0,64).map(async (node,index) => {
        const agent = repo.listAgents().find(a => a.nodeId === node.id);
        const result = await nodes.test({type:"node.test",id:node.id,baseUrl:node.baseUrl,profileId:agent?.chatProfileId ?? agent?.profileId ?? "health"});
        return {id:"node-"+(index+1),label:node.label.slice(0,100),state:result.reachable ? "available" as const : "unavailable" as const,detail:result.reachable ? "节点健康接口可达；真实模型任务需另行试跑" : ("节点连接检查失败："+result.error).slice(0,500),checkedAt};
      }));
      const githubState = github.status();
      return [...nodeChecks,
        {id:"comfyui",label:"本机画图",state:comfyConfig ? "configured" as const : "unconfigured" as const,detail:comfyConfig ? "工作流已配置，未启动绘图任务" : "请配置 comfyui.json",checkedAt},
        {id:"asr",label:"录音转写",state:asr.config ? "configured" as const : "unconfigured" as const,detail:asr.config ? "Python、脚本和模型路径存在；CUDA 与实际转写尚待试跑" : "请检查 asr.json 的 Python、脚本与模型路径",checkedAt},
        {id:"tts",label:"语音合成",state:ttsConfig && existsSync(ttsConfig.python) && existsSync(ttsConfig.script) ? "configured" as const : "unconfigured" as const,detail:"检查语音包和声音配置；此检查不会加载模型或合成语音",checkedAt},
        {id:"github",label:"GitHub 同步",state:githubState.lastError ? "unavailable" as const : "unknown" as const,detail:githubState.lastError ? ("同步错误："+githubState.lastError).slice(0,500) : "最近状态未报告错误；这不是本次推送成功的证明",checkedAt}];
    },
  });
  const packs = new PacksService({
    dialog: { showOpenDialog: (options) => dialog.showOpenDialog(options as never) },
    installDir: dirname(process.execPath),
    resourcesPath: process.resourcesPath,
    localAppData: process.env.LOCALAPPDATA,
    emit: broadcast,
  });

  const dispatcher = createDispatcher({
    workspace,
    github,
    repo,
    settings,
    orchestrator,
    discussion,
    chat,
    notes,
    media,
    jobs,
    voices: () => (ttsConfig === null ? [] : voiceOptionsOf(ttsConfig)),
    voice,
    packs,
    nodes,
    appVersion: app.getVersion(),
    recoveredRuns: repaired.repaired.length + repairedChat,
    emit: broadcast,
  });

  ipcMain.handle(IPC_CHANNELS.command, async (_event, request: unknown) => dispatcher.handleCommand(request));
  ipcMain.handle(IPC_CHANNELS.query, async (_event, request: unknown) => dispatcher.handleQuery(request));

  app.on("before-quit", () => {
    // 让节点立刻停下，而不是等租约过期（abort 由 orchestrator / chat 统一发出）
    orchestrator.cancelAll();
    chat.cancelAll();
    github.stop();
    // 语音合成的子进程也一起收掉，别留后台进程
    ttsRunner?.dispose();
    // D-34b：转写 sidecar 是独立进程，退出时一起收掉
    voice.dispose();
    try {
      db.close();
    } catch {
      // 已经关闭
    }
  });

  const cliExit = await runCliIfRequested({
    db,
    nodes,
    settings,
    packs,
    userData,
    localAppData: process.env.LOCALAPPDATA,
    installDir: dirname(process.execPath),
    resourcesPath: process.resourcesPath,
    execPath: process.execPath,
  });
  if (cliExit !== null) {
    // app.exit 不触发 before-quit：先关库，别把这次的写入留在 -wal 里
    try {
      db.close();
    } catch {
      // 关不掉也让进程退出
    }
    app.exit(cliExit);
    return;
  }

  createWindow();
}

void app.whenReady().then(async () => {
  try {
    if(existsSync(dataLocationFile)){
      const location:unknown=JSON.parse(readFileSync(dataLocationFile,"utf8"));
      if(typeof location!=="object"||location===null||!("directory" in location)||typeof location.directory!=="string"||!isAbsolute(location.directory)||!existsSync(join(location.directory,"room.db")))throw new Error("恢复副本目录不存在，请恢复 active-data.json 指向的目录或移除该选择文件后打开原资料");
      app.setPath("userData",location.directory);
    }
    await bootstrap();
  } catch (error) {
    // 迁移失败 / DB 被锁：以前这里会把 promise 丢掉，窗口不开、进程还挂着
    const message = error instanceof Error ? error.message : String(error);
    if (cliRequested) {
      console.error("[startup] 启动失败：" + message);
      app.exit(1);
      return;
    }
    dialog.showErrorBox("启动失败", "无法初始化本地数据库或设置：\n" + message);
    app.quit();
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});


