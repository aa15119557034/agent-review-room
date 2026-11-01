import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { ModelOption, NODE_MIN_BODY_BYTES_WITH_ATTACHMENTS, ProfileId, VisionSupport } from "@room/schemas";
import { PARSERS } from "./parsers";
import { planSpawn, type ResolveEnv } from "./win-command";
import { buildArgs, modelConfigProblems } from "./model-args";

/**
 * 节点本地配置。能跑什么命令只由这里决定，远端请求只能按 profileId 选择。
 */
const Profile = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    /**
     * 工作目录。Reviewer 建议指向一个**空的专用文件夹**：
     * claude -p 会读取工作目录里的 CLAUDE.md / .claude 配置，空文件夹可以避免把无关内容带进评审。
     */
    cwd: z.string().min(1),
    /** 只把这些环境变量传给子进程 */
    envAllowlist: z
      .array(z.string())
      .default(["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "LANG"]),
    /** 额外固定注入的环境变量（不要放密钥） */
    env: z.record(z.string(), z.string()).default({}),
    /**
     * S-20 第二段：从文件读的环境变量（变量名 → 文件路径，相对路径相对配置文件），每次启动 CLI 时现读、去掉首尾空白。
     * 给密钥用（比如汐的 DEEPSEEK_API_KEY）：文件放在 node\<秘书>\ 里，只有这位秘书的账号和管理员能读；
     * 节点不打印、不回传它的内容，读不到时这次 Run 按 spawn_failed 结束，消息里只有路径
     */
    envFiles: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().min(1)).default({}),
    /**
     * stdout 的解析方式：
     * - raw：原样以 output 事件转发
     * - claude-stream-json：解析 `claude -p --output-format stream-json` 的输出，转成 text_delta / message_complete
     * - codex-exec-json：解析 `codex exec --json` 的输出（S-10）
     * - room-jsonl：本仓库自带脚本的输出，目前是 bin/deepseek-chat.mjs（S-10）
     */
    parser: z.enum(PARSERS).default("raw"),
    verifyCommit: z.boolean().default(false),
    /**
     * S-22：这个 profile 能选的模型和强度，原样在 health 里上报。空 = 模型写死在 args 里，不接受选择。
     * 档位从弱到强排；名字要用 CLI 实测过的（有的 CLI 遇到不认识的档位只警告不报错，节点靠这份清单拒绝）。
     */
    models: z.array(ModelOption).max(16).default([]),
    /** 选了模型时加的参数，{model} 换成模型 id，例如 ["--model", "{model}"] */
    modelArgs: z.array(z.string()).default([]),
    /** 模型有档位时再加的参数，{effort} 换成档位 id，例如 ["--effort", "{effort}"] */
    effortArgs: z.array(z.string()).default([]),
    maxIdleTimeoutMs: z.number().int().positive().default(300_000),
    maxTotalTimeoutMs: z.number().int().positive().default(3_600_000),
    /**
     * S-20：聊天时读的记忆文件夹（ADR-003 §2a）。只有 id 以 -chat 结尾的 profile 能配。
     * dir 只能是 `memory/<agent>`，相对节点配置的 homeDir；provider 1B 只有 folder
     */
    memory: z.object({ dir: z.string().min(1), provider: z.literal("folder") }).strict().optional(),
    /**
     * S-23：带图时怎么把图交给 CLI（契约 C-42g：「标记前文字 → 图片块 → 标记后文字」都写进 stdin）。
     * - claude-stream-json：claude -p 的 stream-json 输入，args 填 ["--input-format", "stream-json"]
     * - openai-content-json：bin/deepseek-chat.mjs，args 填 ["--input-format", "content-json"]
     * args 只在这次带图时加在最后。没配 = 这个 profile 收不了图，模型的 vision 不能报 yes。
     * Codex 的 exec 只能用 -i 把图放在全部文字前面，做不到这个顺序，所以不提供命令行参数的交法（ADR-004 §2）
     */
    images: z
      .object({
        input: z.enum(["claude-stream-json", "openai-content-json"]),
        args: z.array(z.string()).default([]),
      })
      .strict()
      .optional(),
    /** S-23：models 为空（模型写死）时那个模型能不能看图，用 vision-test 实测后填。不填 = unknown */
    fixedModelVision: VisionSupport.optional(),
    /**
     * S-23：画图 profile（契约 C-42b 的 kind = "image"）。只接受 image Run，不接受文字 Run。
     * outputDir：节点专用的根目录（相对路径相对配置文件）。每个 Run 在下面新建 `<runId>` 子目录，
     * 用 args 里的 `{image-output-dir}` 或环境变量 ROOM_IMAGE_OUTPUT_DIR 告诉 CLI 把图写在那里；
     * 节点只从这个子目录取图、只删这个子目录。不要指向 CLI 自己的共享目录（例如 $CODEX_HOME/generated_images）
     */
    imageRun: z.object({ outputDir: z.string().min(1) }).strict().optional(),
    /**
     * S-24：这个 profile 的订阅额度怎么读（契约 C-42b 的 GET /v1/profiles/:profileId/quota）。
     * codex-app-server：用同一个 command 起 `codex app-server`（args 默认 ["app-server"]），读 account/rateLimits/read，
     * 2 秒读不到报「未知」。环境变量和跑 Run 一样只给 envAllowlist，Codex 的登录在 CODEX_HOME 里，所以要放行它
     */
    quota: z
      .discriminatedUnion("source", [
        z
          .object({
            source: z.literal("codex-app-server"),
            args: z.array(z.string()).default(["app-server"]),
          })
          .strict(),
        /**
         * S-21：Claude 不单独读额度——每次跑 `claude -p --output-format stream-json` 时 CLI 会顺带输出 rate_limit_event，
         * 节点记下最近一次（同一个 account 的所有 claude-stream-json profile 共用，一个节点一个账号时用默认值就行）。
         * 不额外花额度；节点刚启动、还没跑过 Run 时报「未知」
         */
        z
          .object({
            source: z.literal("claude-stream"),
            account: z.string().min(1).max(40).default("claude"),
          })
          .strict(),
        /**
         * S-21：DeepSeek 按量计费，读余额 GET <baseUrl>/user/balance。API Key 从环境变量 apiKeyEnv 读
         * （必须在 envAllowlist 里，和跑 Run 一样），不打印、不回传；2 秒读不到报「未知」
         */
        z
          .object({
            source: z.literal("deepseek-balance"),
            baseUrl: z.string().url().default("https://api.deepseek.com"),
            apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).default("DEEPSEEK_API_KEY"),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();

export const ServerConfig = z
  .object({
    nodeId: z.string().min(1),
    /**
     * 监听地址。默认 0.0.0.0：主控端在另一台电脑上，必须能从局域网访问。
     * 只在本机测试时可以改成 127.0.0.1。
     */
    host: z.string().default("0.0.0.0"),
    port: z.number().int().min(1).max(65535).default(7420),
    /** Token 文件路径（相对于配置文件）。也可以用环境变量 AGENT_SERVER_TOKEN 覆盖 */
    tokenFile: z.string().default("agent-server.token"),
    maxConcurrentRuns: z.number().int().positive().default(1),
    /** 没有订阅者超过这个时间就终止 run。必须小于主控端的 reconnectGraceMs */
    leaseMs: z.number().int().positive().default(20_000),
    heartbeatMs: z.number().int().positive().default(5_000),
    killGraceMs: z.number().int().positive().default(5_000),
    /**
     * 请求体上限。S-23 起默认等于契约的 NODE_MIN_BODY_BYTES_WITH_ATTACHMENTS（约 28.4 MB，8 张图 base64 + 最长的 content）；
     * 调小到它以下时节点不报 capabilities.attachments（主控端不会给它发图）
     */
    maxBodyBytes: z.number().int().positive().default(NODE_MIN_BODY_BYTES_WITH_ATTACHMENTS),
    maxOutputBytes: z.number().int().positive().default(16 * 1024 * 1024),
    finishedRunTtlMs: z.number().int().positive().default(10 * 60_000),
    profiles: z.record(ProfileId, Profile),
    /** S-20：这台电脑的 <AgentRoom>（绝对路径，本机 NTFS）。配了记忆的节点必填 */
    homeDir: z.string().min(1).optional(),
    /** S-20：这个节点属于哪位秘书。填了以后所有 profile id 必须以 `<agent>-` 开头；配了记忆的节点必填 */
    agent: z.enum(["claude", "deepseek", "codex"]).optional(),
    /** S-20：节点必须以这个 Windows 账号运行（计划任务里的 agentroom-<秘书>），不对就拒绝启动 */
    runAsUser: z.string().min(1).optional(),
  })
  .strict();

export type ServerConfig = z.infer<typeof ServerConfig>;
export type Profile = z.infer<typeof Profile>;

export interface LoadedConfig {
  config: ServerConfig;
  token: string;
  configPath: string;
}

export const TOKEN_MIN_LENGTH = 32;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const configPath = resolve(env["AGENT_SERVER_CONFIG"] ?? "agent-server.config.json");
  if (!existsSync(configPath)) {
    throw new Error(`找不到配置文件 ${configPath}。先运行一次：pnpm --filter @room/agent-server run setup`);
  }
  const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  const config = ServerConfig.parse(raw);
  const baseDir = dirname(configPath);

  // 相对路径一律相对于配置文件所在目录，避免"从哪个目录启动"影响行为
  for (const p of Object.values(config.profiles)) {
    if (!isAbsolute(p.cwd)) p.cwd = resolve(baseDir, p.cwd);
    if (p.imageRun && !isAbsolute(p.imageRun.outputDir)) p.imageRun.outputDir = resolve(baseDir, p.imageRun.outputDir);
    for (const [k, f] of Object.entries(p.envFiles)) if (!isAbsolute(f)) p.envFiles[k] = resolve(baseDir, f);
  }

  const token = (env["AGENT_SERVER_TOKEN"] ?? readTokenFile(resolve(baseDir, config.tokenFile))).trim();
  if (token.length < TOKEN_MIN_LENGTH) {
    throw new Error(
      `Token 太短或不存在（至少 ${TOKEN_MIN_LENGTH} 个字符）。运行 pnpm --filter @room/agent-server run setup 生成一个。`,
    );
  }
  return { config, token, configPath };
}

function readTokenFile(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/**
 * 启动前检查每个 profile：命令能找到、Windows 上 .cmd 参数安全、工作目录存在。
 * 有问题直接报错退出，不要等到第一次评审才失败。
 */
export function validateProfiles(config: ServerConfig, r?: ResolveEnv): string[] {
  const problems: string[] = [];
  // health 的 profileModels 每个 profile 一条，契约上限 64
  if (Object.keys(config.profiles).length > 64) problems.push("profile 最多 64 个");
  for (const [id, p] of Object.entries(config.profiles)) {
    if (new Set(p.models.map((m) => m.id)).size !== p.models.length) problems.push(`profile "${id}": 模型 id 重复`);
    for (const m of modelConfigProblems(p)) problems.push(`profile "${id}": ${m}`);
    for (const m of imageConfigProblems(p)) problems.push(`profile "${id}": ${m}`);
    for (const m of chatProfileProblems(id, p)) problems.push(`profile "${id}": ${m}`);
    for (const [k, f] of Object.entries(p.envFiles)) {
      if (!(r?.exists ?? existsSync)(f)) problems.push(`profile "${id}": envFiles.${k} 的文件不存在：${f}`);
    }
    // 每个模型、每个档位拼出来的命令都要能安全启动（Windows .cmd 的参数检查也在 planSpawn 里）
    const withImages = (args: string[]) => (p.images ? [args, [...args, ...p.images.args]] : [args]);
    const variants = [
      buildArgs(p),
      ...p.models.flatMap((m) =>
        m.efforts.length === 0
          ? [buildArgs(p, { model: m.id, effort: null })]
          : m.efforts.map((e) => buildArgs(p, { model: m.id, effort: e.id })),
      ),
    ];
    for (const args of variants.flatMap(withImages)) {
      try {
        planSpawn(p.command, args, r);
      } catch (err) {
        problems.push(`profile "${id}": ${(err as Error).message}`);
        break;
      }
    }
    const exists = r?.exists ?? existsSync;
    if (!exists(p.cwd) || (!r && !statSync(p.cwd).isDirectory())) {
      problems.push(`profile "${id}": 工作目录不存在：${p.cwd}`);
    }
  }
  return problems;
}

/** 聊天 profile 里不能出现的参数：放开权限、可写沙箱、额外目录 */
const CHAT_FORBIDDEN_ARGS = [
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "bypassPermissions",
  "acceptEdits",
  "workspace-write",
  "danger-full-access",
  "--full-auto",
  "--yolo",
  "--add-dir",
  "--allowedTools",
  "--allowed-tools",
];

const commandName = (command: string) =>
  command
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(cmd|bat|exe|ps1)$/i, "")
    .toLowerCase();

const hasPair = (args: readonly string[], flag: string, value: string) =>
  args.some((a, i) => (a === flag && args[i + 1] === value) || a === `${flag}=${value}`);

/**
 * S-20 第二段：聊天 profile（id 以 -chat 结尾）只能说话（ADR-003 §6）。这里只是第一道：
 * 配置里没写关工具的参数就拒绝启动；真正有没有关掉，按任务板 S-20 ① 用真实启动的 profile 实测（scripts/verify-isolation.ps1）。
 * - claude：`--tools=`（空 = 一个内置工具都不给）+ `--strict-mcp-config`（不加载任何 MCP）+ `--permission-mode dontAsk`
 * - codex：`--sandbox read-only` + `--disable shell_tool`（不给跑命令的工具）
 * - 其他命令（比如 node bin/deepseek-chat.mjs）本身没有工具
 */
export function chatProfileProblems(id: string, p: Profile): string[] {
  if (!id.endsWith("-chat")) return [];
  const problems: string[] = [];
  // 只按整个参数比：等于、`flag=值`，或者是 --permission-mode / --sandbox 这类开关后面的值（汐 #138：子串匹配会误伤路径和提示词）
  // `-c sandbox_mode=workspace-write` 这种：值等于禁用的那个也算
  const bad = p.args.filter((a) => CHAT_FORBIDDEN_ARGS.some((f) => a === f || a.startsWith(f + "=") || a.endsWith("=" + f)));
  if (bad.length) problems.push(`聊天 profile 不能带这些参数：${bad.join(" ")}`);
  if (p.imageRun) problems.push("聊天 profile 不能是画图 profile");
  if (p.verifyCommit) problems.push("聊天 profile 不读仓库，不要开 verifyCommit");
  const name = commandName(p.command);
  if (name === "claude") {
    if (!p.args.includes("--tools=")) problems.push("claude 的聊天 profile 要带 --tools=（关掉全部内置工具）");
    if (!p.args.includes("--strict-mcp-config")) problems.push("claude 的聊天 profile 要带 --strict-mcp-config（不加载 MCP 工具）");
    if (!hasPair(p.args, "--permission-mode", "dontAsk")) problems.push("claude 的聊天 profile 要带 --permission-mode dontAsk");
  }
  if (name === "codex") {
    if (!hasPair(p.args, "--sandbox", "read-only")) problems.push("codex 的聊天 profile 要带 --sandbox read-only");
    if (!hasPair(p.args, "--disable", "shell_tool")) problems.push("codex 的聊天 profile 要带 --disable shell_tool（不给跑命令的工具）");
  }
  return problems;
}

/** S-23：看图 / 画图配置要配得上 */
export function imageConfigProblems(p: Profile): string[] {
  const problems: string[] = [];
  if (p.fixedModelVision !== undefined && p.models.length > 0) {
    problems.push("有 models 清单时看图能力写在每个模型的 vision 上，不写 fixedModelVision");
  }
  const saysYes = p.fixedModelVision === "yes" || p.models.some((m) => m.vision === "yes");
  if (saysYes && !p.images) problems.push("有模型报 vision: yes，但没配 images（不知道怎么把图交给 CLI）");
  if (p.images?.input === "claude-stream-json" && p.parser !== "claude-stream-json") {
    problems.push("images.input 为 claude-stream-json 时 parser 也要是 claude-stream-json");
  }
  if (p.images?.input === "openai-content-json" && p.parser !== "room-jsonl") {
    problems.push("images.input 为 openai-content-json 时 parser 要是 room-jsonl（本仓库脚本）");
  }
  if (p.quota?.source === "claude-stream" && p.parser !== "claude-stream-json") {
    problems.push("quota.source 为 claude-stream 时 parser 要是 claude-stream-json（额度从它的输出里读）");
  }
  if (p.quota?.source === "deepseek-balance" && !p.envAllowlist.includes(p.quota.apiKeyEnv)) {
    problems.push(`quota.source 为 deepseek-balance 时 envAllowlist 要包含 ${p.quota.apiKeyEnv}`);
  }
  if (p.imageRun && p.images) problems.push("画图 profile 不收图（image Run 不能带附件），不要同时配 images");
  if (p.imageRun && p.memory) problems.push("画图 profile 不读记忆");
  if (!p.imageRun && p.args.some((a) => a.includes("{image-output-dir}"))) {
    problems.push("args 里的 {image-output-dir} 只给画图 profile（配了 imageRun）用");
  }
  return problems;
}
