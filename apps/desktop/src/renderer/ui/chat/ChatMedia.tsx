import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  CHAT_LIMITS,
  DRAW_PROMPT_MAX_CHARS,
  DrawSize,
  IMMERSIVE_LIMITS,
  type AgentChatMessage,
  type ChatAttachment,
  type Conversation,
  type DrawRequest,
  type DrawRoutePreview,
  type ImmersiveSettings,
  type MediaJob,
  type UserChatMessage,
} from "@room/schemas";
import {
  CODEX_MANUAL_LABEL,
  audioSrc,
  canRetryLocally,
  durationText,
  imageSrc,
  jobActive,
  jobEndText,
  jobsOf,
  routePreviewText,
  routeText,
  showDrawCard,
  canSpeak,
  visionWarnings,
  voiceBubbleWidth,
  JOB_STATE_LABEL,
} from "../../lib/media";
import { draftOf } from "../../lib/chat";
import { useActions, useAppState } from "../hooks";

/**
 * 聊天里的多模态（C-43，契约 C-42a～e）。
 * - 图片 / 声音只用 room-image:// / room-audio://（mock 下换成 data:），renderer 拿不到路径
 * - 生成任务的进度和结局只看后端推来的 MediaJob；取消、「停」之后到的结果由后端丢掉
 * - 动效只有录音时的小红点闪烁，「减少动态效果」下关掉（styles.css 全局规则）
 */

// ================================================================ 你发的消息

export function UserContent({ message, children }: { message: UserChatMessage; children?: React.ReactNode }) {
  const c = message.content;
  if (c.kind === "sticker") {
    return <img className="chat-sticker" src={imageSrc(c.image)} alt={`[表情：${c.label}]`} title={c.label} />;
  }
  if (c.kind === "voice") {
    return (
      <div className="chat-bubble chat-voice">
        <VoiceNote src={audioSrc(c.audio)} durationMs={c.durationMs} />
        <p className="chat-text chat-transcript">
          {c.transcript.text}
          {c.transcript.source === "edited" && <span className="tag">转写改过</span>}
        </p>
      </div>
    );
  }
  const images = c.attachments.filter((a): a is Extract<ChatAttachment, { kind: "image" }> => a.kind === "image");
  const files = c.attachments.filter((a): a is Extract<ChatAttachment, { kind: "file" }> => a.kind === "file");
  return (
    <div className="chat-bubble">
      {images.length > 0 && <ImageGrid images={images} />}
      {files.map((f) => (
        <FileCard key={f.ref} file={f} />
      ))}
      {c.text.trim() && <p className="chat-text">{c.text}</p>}
      {children}
    </div>
  );
}

function ImageGrid({ images }: { images: { ref: string; name: string }[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const shown = images.find((i) => i.ref === open);
  return (
    <>
      <ul className="chat-images" data-count={images.length}>
        {images.map((img) => (
          <li key={img.ref}>
            <button type="button" onClick={() => setOpen(img.ref)} aria-label={`看大图：${img.name}`}>
              <img src={imageSrc(img.ref)} alt={img.name} loading="lazy" />
            </button>
          </li>
        ))}
      </ul>
      {shown && <Lightbox src={imageSrc(shown.ref)} alt={shown.name} onClose={() => setOpen(null)} />}
    </>
  );
}

export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={alt} onClick={onClose}>
      <img src={src} alt={alt} />
      <p>{alt} · 点任意处关闭</p>
    </div>
  );
}

const sizeText = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

function FileCard({ file }: { file: Extract<ChatAttachment, { kind: "file" }> }) {
  return (
    <p className="chat-file" title={file.isText ? "文字文件：正文会作为资料发给秘书" : "这类文件 1B 不解析，秘书只看到文件名"}>
      <span className="chat-file-icon" aria-hidden="true">
        {file.isText ? "文" : "档"}
      </span>
      <span className="chat-file-name">{file.name}</span>
      <span className="chat-file-meta">
        {sizeText(file.bytes)}
        {!file.isText && " · 秘书只看到文件名"}
      </span>
    </p>
  );
}

/** 你的录音：自己的小播放器（不进秘书语音的自动播放队列） */
function VoiceNote({ src, durationMs }: { src: string; durationMs: number }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  return (
    <button
      type="button"
      className="voice-pill"
      style={{ width: voiceBubbleWidth(durationMs) }}
      aria-label={playing ? "停止播放录音" : `播放录音，${durationText(durationMs)}`}
      data-playing={playing || undefined}
      onClick={() => {
        const a = ref.current;
        if (!a) return;
        if (playing) {
          a.pause();
          a.currentTime = 0;
        } else void a.play().catch(() => setPlaying(false));
      }}
    >
      <span aria-hidden="true">{playing ? "■" : "▶"}</span>
      <span className="voice-wave" aria-hidden="true" />
      {durationText(durationMs)}
      <audio ref={ref} src={src} preload="none" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
    </button>
  );
}

// ================================================================ 秘书的回答下面

/** 语音（播放 / 合成中 / 自动合成的语音气泡）和画图（请求卡 / 任务 / 画好的图） */
export function AgentMedia({ message, conv }: { message: AgentChatMessage; conv: Conversation }) {
  const jobs = useAppState((s) => s.chat.media.jobs);
  const requested = useAppState((s) => s.chat.media.drawRequested[message.id] === true);
  const draws = jobsOf(jobs, message.id, "draw");
  return (
    <div className="agent-media">
      <SpeechLine message={message} />
      {draws.map((j) => (
        <DrawJobView key={j.id} job={j} message={message} conv={conv} />
      ))}
      {showDrawCard(message, jobs) && (
        <DrawOffer message={message} lastFailed={draws.filter((j) => !jobActive(j)).at(-1)} drawnEarlier={draws.length === 0 && requested} />
      )}
    </div>
  );
}

/** 你自己的消息下面：用「照这条画一张」从这条发起的画图（任务、进度、画好的图、失败和重试） */
export function UserDraws({ message, conv }: { message: UserChatMessage; conv: Conversation }) {
  const jobs = useAppState((s) => s.chat.media.jobs);
  const draws = jobsOf(jobs, message.id, "draw");
  if (draws.length === 0) return null;
  return (
    <div className="agent-media">
      {draws.map((j) => (
        <DrawJobView key={j.id} job={j} message={message} conv={conv} />
      ))}
    </div>
  );
}

function SpeechLine({ message }: { message: AgentChatMessage }) {
  // 流式回答时历史消息会跟着重渲染：朗读过滤只在正文变了才重算
  const speakable = useMemo(() => canSpeak(message.text), [message.text]);
  const jobs = useAppState((s) => jobsOf(s.chat.media.jobs, message.id, "speech"));
  const clip = useAppState((s) => s.chat.media.clips[message.id]);
  const playing = useAppState((s) => s.chat.media.playing === message.id);
  const queued = useAppState((s) => s.chat.media.playQueue.includes(message.id));
  const voice = useAppState((s) => s.disc.agents.find((a) => a.id === message.agent)?.voice);
  const actions = useActions();
  const last = jobs.at(-1);
  const auto = jobs.find((j) => j.authorization === "immersive" || j.authorization === "reply_as_voice");
  const tag = auto?.authorization === "immersive" ? <span className="tag tag-immersive">沉浸</span> : auto ? <span className="tag">你要的语音</span> : null;

  if (clip) {
    return (
      <p className="speech-line">
        <button
          type="button"
          className="voice-pill voice-pill-agent"
          style={{ width: voiceBubbleWidth(clip.durationMs) }}
          data-playing={playing || undefined}
          aria-label={playing ? "停止播放" : `播放语音，${durationText(clip.durationMs)}`}
          onClick={() => (playing ? actions.chat.media.stopPlaying() : void actions.chat.media.play(message.id, message.agent))}
        >
          <span aria-hidden="true">{playing ? "■" : "▶"}</span>
          <span className="voice-wave" aria-hidden="true" />
          {durationText(clip.durationMs)}
        </button>
        {queued && <span className="chat-note">等前一段播完</span>}
        {tag}
      </p>
    );
  }
  if (last && jobActive(last)) {
    return (
      <p className="speech-line chat-note">
        {last.state === "queued" ? "语音排队中（显卡一次只做一件事）" : "正在合成语音…"}
        {tag}
        <button type="button" className="button-link" onClick={() => void actions.chat.media.cancelJob(last.id)}>
          取消
        </button>
      </p>
    );
  }
  if (!speakable) return null;
  const wants = message.mediaIntent?.speak === true;
  return (
    <p className="speech-line">
      <button
        type="button"
        className="button-link"
        disabled={!voice}
        title={voice ? "用这位的声音读出来（在主控机本地合成）" : "还没给这位选声音：设置 → 参与者 → 声音"}
        onClick={() => void actions.chat.media.play(message.id, message.agent)}
      >
        ▶ {wants ? "想用语音说，点这里听" : "播放"}
      </button>
      {!voice && <span className="chat-note">还没选声音</span>}
      {message.immersiveDeferred?.speak === "hourly_limit" && <span className="chat-note">这个小时自动语音的名额用完了</span>}
      {last && !jobActive(last) && last.state !== "succeeded" && <span className="chat-note">上次：{jobEndText(last)}</span>}
    </p>
  );
}

function DrawOffer({ message, lastFailed, drawnEarlier }: { message: AgentChatMessage; lastFailed: MediaJob | undefined; drawnEarlier: boolean }) {
  const actions = useActions();
  const name = useAppState((s) => s.disc.agents.find((a) => a.id === message.agent)?.displayName ?? message.agent);
  const draw = message.mediaIntent!.draw!;
  return (
    <div className="draw-offer">
      <p>
        <b>{name}</b> 想画一张：<span className="draw-prompt">{draw.prompt}</span>
      </p>
      {message.immersiveDeferred?.draw === "hourly_limit" && <p className="chat-note">沉浸模式这个小时自动画图的名额用完了，等你点。</p>}
      {lastFailed && <p className="chat-note">上次：{jobEndText(lastFailed)}</p>}
      {drawnEarlier && <p className="chat-note">这条你已经让画过了（图在较早的记录里，这里没加载到）。再画会再花一次额度。</p>}
      <button type="button" className="button-outline" onClick={() => actions.chat.media.openDrawCard(message.id, draw.prompt)}>
        {drawnEarlier ? "再画一张…" : "画…"}
      </button>
    </div>
  );
}

function DrawJobView({ job, message, conv }: { job: MediaJob; message: AgentChatMessage | UserChatMessage; conv: Conversation }) {
  const actions = useActions();
  const [zoom, setZoom] = useState(false);
  const starting = useAppState((s) => s.chat.media.drawStarting[message.id] === true);
  // 只有这条消息最近的那个任务给重试入口（showDrawCard 这时不显示卡片，入口只有这一处）
  const latest = useAppState((s) => jobsOf(s.chat.media.jobs, message.id, "draw").at(-1)?.id === job.id);
  const retry = latest && canRetryLocally(job);
  const immersive = job.authorization === "immersive" ? <span className="tag tag-immersive">沉浸</span> : null;
  if (jobActive(job)) {
    return (
      <p className="draw-job chat-note" data-state={job.state}>
        {immersive}🎨 {JOB_STATE_LABEL[job.state]}
        {job.state === "running" && job.route && ` · ${job.route.backend === "codex" ? "林离" : "本机"}`}：{job.draw?.prompt.slice(0, 40)}
        <button type="button" className="button-link" onClick={() => void actions.chat.media.cancelJob(job.id)}>
          取消
        </button>
      </p>
    );
  }
  if (job.state === "succeeded" && job.result) {
    const r = job.result;
    return (
      <figure className="draw-result">
        <button type="button" onClick={() => setZoom(true)} aria-label="看大图">
          <img src={imageSrc(r.ref)} alt={`画的图：${r.prompt}`} loading="lazy" />
        </button>
        <figcaption>
          {immersive}
          {job.route && routeText(job.route)}
          <details>
            <summary>提示词</summary>
            <p className="draw-prompt">{r.prompt}</p>
            <p className="chat-note">
              {r.size}
              {r.model && ` · ${r.model}`}
              {r.seed !== null && ` · 种子 ${r.seed}`}
            </p>
          </details>
        </figcaption>
        {zoom && <Lightbox src={imageSrc(r.ref)} alt={r.prompt} onClose={() => setZoom(false)} />}
      </figure>
    );
  }
  return (
    <p className="draw-job chat-note" data-state={job.state}>
      {immersive}🎨 {jobEndText(job)}
      {job.failure?.message && <span title={job.failure.message}> · {job.failure.message.slice(0, 60)}</span>}
      {retry && job.draw && (
        <button
          type="button"
          className="button-link"
          disabled={starting}
          onClick={() =>
            void actions.chat.media.startDraw(
              { ...job.draw!, backend: "comfyui" },
              { kind: "chat", conversationId: conv.id, messageId: message.id, agent: message.sender === "agent" ? message.agent : null },
              false,
            )
          }
        >
          改用本机画
        </button>
      )}
      {retry && job.draw && (
        <button type="button" className="button-link" disabled={starting} onClick={() => actions.chat.media.openDrawCard(message.id, job.draw!.prompt)}>
          换个画法…
        </button>
      )}
    </p>
  );
}

// ================================================================ 画图请求卡

export function DrawSheetBody({ messageId, prompt: initial, conv }: { messageId: string; prompt: string; conv: Conversation }) {
  const message = useAppState((s) => s.chat.messages.find((m) => m.id === messageId));
  const actions = useActions();
  const [prompt, setPrompt] = useState(initial);
  const [size, setSize] = useState<DrawRequest["size"]>(
    message?.sender === "agent" && message.mediaIntent?.draw ? message.mediaIntent.draw.size : "1024x1024",
  );
  const [backend, setBackend] = useState<DrawRequest["backend"]>("auto");
  const [preview, setPreview] = useState<DrawRoutePreview | null | undefined>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const trimmed = prompt.trim();
  const request: DrawRequest = { prompt: trimmed || "-", size, backend };

  // 打开和换路时预览一次（main 现读额度，2 秒超时）。提示词不影响选路，不用跟着打字重读
  useEffect(() => {
    let alive = true;
    setPreview(null);
    setConfirming(false);
    void actions.chat.media.previewDraw({ prompt: "-", size, backend }).then((p) => alive && setPreview(p));
    return () => {
      alive = false;
    };
  }, [actions, size, backend]);

  if (!message) return null;
  const source = { kind: "chat" as const, conversationId: conv.id, messageId, agent: message.sender === "agent" ? message.agent : null };
  const manualCodex = backend === "codex" && preview ? preview.codexManual : "none";
  const blocked = manualCodex === "blocked" || (preview !== undefined && preview !== null && preview.backend === null);
  const needConfirm = manualCodex === "confirm" && !confirming;
  // 预览还没回来（null）先不让点：可能正好是林离额度用满，main 会拒
  const ok = trimmed.length > 0 && trimmed.length <= DRAW_PROMPT_MAX_CHARS && !blocked && !busy && preview !== null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    if (needConfirm) return setConfirming(true);
    setBusy(true);
    await actions.chat.media.startDraw({ ...request, prompt: trimmed }, source, manualCodex === "confirm");
    setBusy(false);
  };

  return (
    <form className="chat-sheet-body draw-card" onSubmit={submit}>
      <label className="chat-field">
        画什么（秘书写的，你可以改）
        <textarea rows={4} maxLength={DRAW_PROMPT_MAX_CHARS} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <fieldset>
        <legend>尺寸</legend>
        <div className="seg">
          {DrawSize.options.map((s) => (
            <label key={s}>
              <input type="radio" name="draw-size" checked={size === s} onChange={() => setSize(s)} />
              {s.replace("x", " × ")}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>用哪条路</legend>
        <div className="seg">
          {(
            [
              ["auto", "自动（先林离，到 85% 换本机）"],
              ["codex", "林离"],
              ["comfyui", "本机"],
            ] as const
          ).map(([v, label]) => (
            <label key={v}>
              <input type="radio" name="draw-backend" checked={backend === v} onChange={() => setBackend(v)} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="chat-note" role="status">
        {preview === null ? "正在看这次走哪条路…" : preview === undefined ? "现在看不到走哪条路（后端还不能画图）" : routePreviewText(preview)}
      </p>
      {preview?.backend === "codex" && <p className="chat-note">走林离时提示词会发给 Codex 订阅服务。</p>}
      {backend === "codex" && CODEX_MANUAL_LABEL[manualCodex] && <p className="field-error">{CODEX_MANUAL_LABEL[manualCodex]}</p>}
      <button type="submit" className="button-primary" disabled={!ok}>
        {busy ? "开始中…" : confirming ? "确定用林离画" : "画"}
      </button>
    </form>
  );
}

// ================================================================ 会话顶部：沉浸标记和「停」

export function MediaHead() {
  const active = useAppState((s) => s.chat.media.jobs.filter(jobActive).length);
  const immersive = useAppState((s) => s.chat.media.immersive?.settings.enabled === true);
  const actions = useActions();
  return (
    <>
      {immersive && (
        <span className="tag tag-immersive" title="秘书会自己决定发语音、配图（有每小时上限）">
          沉浸
        </span>
      )}
      {active > 0 && (
        <button
          type="button"
          className="button-outline chat-stop"
          title={`取消这个会话现在的 ${active} 个画图 / 语音任务。${immersive ? "沉浸模式仍然开着，下一条回答还可能自动画 / 发语音；要彻底停就关掉沉浸模式" : ""}`}
          onClick={() => void actions.chat.media.stop()}
        >
          停（{active}）
        </button>
      )}
    </>
  );
}

// ================================================================ 会话设置：沉浸模式

export function ImmersiveSection() {
  const state = useAppState((s) => s.chat.media.immersive);
  const actions = useActions();
  if (!state) return <p className="chat-note">沉浸模式：暂时读不到设置（D-39 上线之前是正常的）。</p>;
  const { settings, usage } = state;
  const save = (patch: Partial<ImmersiveSettings>) => void actions.chat.media.updateImmersive({ ...settings, ...patch });
  return (
    <fieldset className="immersive">
      <legend>沉浸模式</legend>
      <label className="chat-toggle">
        <input type="checkbox" checked={settings.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
        开启：秘书自己决定这条要不要用语音发、要不要配一张图，不再等你点
      </label>
      {settings.enabled && (
        <>
          <label className="chat-field">
            每小时最多自动画几张（0～{IMMERSIVE_LIMITS.drawsPerHour}）
            <input
              type="number"
              min={0}
              max={IMMERSIVE_LIMITS.drawsPerHour}
              value={settings.drawsPerHour}
              onChange={(e) => save({ drawsPerHour: clampInt(e.target.value, IMMERSIVE_LIMITS.drawsPerHour) })}
            />
          </label>
          <label className="chat-field">
            每小时最多自动发几段语音（0～{IMMERSIVE_LIMITS.voiceClipsPerHour}）
            <input
              type="number"
              min={0}
              max={IMMERSIVE_LIMITS.voiceClipsPerHour}
              value={settings.voiceClipsPerHour}
              onChange={(e) => save({ voiceClipsPerHour: clampInt(e.target.value, IMMERSIVE_LIMITS.voiceClipsPerHour) })}
            />
          </label>
          <label className="chat-toggle">
            <input type="checkbox" checked={settings.autoDrawUsesSubscription} onChange={(e) => save({ autoDrawUsesSubscription: e.target.checked })} />
            自动画图可以用林离的订阅（到 85% 换本机）；关掉就只用本机，提示词不离开主控机
          </label>
          <p className="chat-note">
            最近 60 分钟：自动画了 {usage.drawsLastHour} 张，自动发了 {usage.voiceClipsLastHour} 段语音。超过上限的退回成请求卡等你点。
          </p>
        </>
      )}
      <p className="chat-note">关掉时会取消这个会话正在排队和生成的画图、语音。顶部的「停」只停这一次，沉浸模式仍然开着。</p>
    </fieldset>
  );
}

const clampInt = (v: string, max: number) => Math.max(0, Math.min(max, Math.trunc(Number(v) || 0)));

// ================================================================ 播放器（秘书的语音）

/**
 * 全局只有一个：按 media.playing 播，播完接着放队列里的下一段（群聊几位同时发语音时按完成顺序）。
 * 窗口不在前台时不自动播（ADR-004 §3a：只显示未播放），等你回来点
 */
export function SpeechPlayer() {
  const playing = useAppState((s) => s.chat.media.playing);
  const clip = useAppState((s) => (s.chat.media.playing ? s.chat.media.clips[s.chat.media.playing] : undefined));
  const actions = useActions();
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    if (!playing || !clip) {
      a.pause();
      return;
    }
    if (document.hidden) {
      actions.chat.media.stopPlaying();
      return;
    }
    a.src = audioSrc(clip.audioRef);
    void a.play().catch(() => actions.chat.media.playEnded());
  }, [playing, clip, actions]);
  return <audio ref={ref} hidden onEnded={() => actions.chat.media.playEnded()} onError={() => playing && actions.chat.media.playEnded()} />;
}

// ================================================================ 输入框

/** 输入框上方：选好的附件（可以去掉）和「谁看不了图」 */
export function AttachmentTray({ conv }: { conv: Conversation }) {
  const draft = useAppState((s) => draftOf(s.chat, s.chat.currentId));
  const vision = useAppState((s) => s.chat.media.vision);
  const names = useAppState((s) => s.disc.agents);
  const actions = useActions();
  if (draft.attachments.length === 0) return null;
  const name = (id: string) => names.find((a) => a.id === id)?.displayName ?? id;
  const recipients =
    conv.kind === "direct" || draft.mentions.kind !== "agents" ? conv.members : draft.mentions.agents;
  const hasImage = draft.attachments.some((a) => a.kind === "image");
  const warnings = hasImage ? visionWarnings(recipients, vision, name) : [];
  const images = draft.attachments.filter((a) => a.kind === "image").length;
  return (
    <div className="attach-tray">
      <ul>
        {draft.attachments.map((a) => (
          <li key={a.ref}>
            {a.kind === "image" ? <img src={imageSrc(a.ref)} alt="" /> : <span className="chat-file-icon">{a.isText ? "文" : "档"}</span>}
            <span className="attach-name">{a.name}</span>
            <button type="button" aria-label={`去掉 ${a.name}`} onClick={() => actions.chat.media.removeAttachment(a.ref)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      {images > CHAT_LIMITS.imagesPerMessage && <p className="field-error">一条最多 {CHAT_LIMITS.imagesPerMessage} 张图</p>}
      {warnings.map((w) => (
        <p key={w} className="chat-note vision-warning">
          {w}
        </p>
      ))}
    </div>
  );
}

/** 录好的语音：转写中 / 转写失败 / 转写好了给你改，发出去的是这段文字 */
export function VoiceDraft() {
  const voice = useAppState((s) => draftOf(s.chat, s.chat.currentId).voice);
  const rec = useAppState((s) => (voice ? s.chat.media.recordings[voice.audio] : undefined));
  const actions = useActions();
  if (!voice) return null;
  return (
    <div className="voice-draft">
      <div className="voice-draft-head">
        {rec && <VoiceNote src={audioSrc(rec.audio)} durationMs={rec.durationMs} />}
        <span className="chat-note">
          {rec?.status === "transcribing" ? "正在本机转写…" : rec?.status === "failed" ? `转写失败：${rec.error}` : "秘书收到的是下面这段文字，发送前可以改"}
        </span>
        <span className="spacer" />
        <button type="button" className="button-link" onClick={actions.chat.media.cancelVoice}>
          不发了
        </button>
      </div>
      {rec?.status === "ready" && (
        <textarea
          rows={2}
          aria-label="转写文字"
          maxLength={CHAT_LIMITS.textMaxChars}
          value={voice.text}
          onChange={(e) => actions.chat.media.setVoiceText(e.target.value)}
        />
      )}
    </div>
  );
}

/** 按一下开始录，再按一下停；最长 5 分钟自动停。录好的整段交给 main（不传路径） */
export function RecordButton({ disabled }: { disabled?: boolean }) {
  const actions = useActions();
  const [state, setState] = useState<"idle" | "recording" | "sending">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // 录音开始时就定下是哪个会话的（林离 #115）：之后切会话也只进这个会话的草稿
  const conversationId = useAppState((s) => s.chat.currentId);
  const rec = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    started: number;
    timer: ReturnType<typeof setInterval>;
    /** 卸载 / 切走时取消：释放麦克风，不导入 */
    cancelled: boolean;
  } | null>(null);
  const alive = useRef(true);
  /** 麦克风授权弹窗还没回来：这期间再点不重复启动（不然会开出两个 MediaRecorder，前一个没人停） */
  const starting = useRef(false);

  // 组件卸载（离开聊天页；ChatView 按会话 key，切会话也会卸载）= 取消这段录音
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const r = rec.current;
      if (!r) return;
      r.cancelled = true;
      clearInterval(r.timer);
      if (r.recorder.state !== "inactive") r.recorder.stop();
      r.stream.getTracks().forEach((t) => t.stop());
      rec.current = null;
    };
  }, []);

  async function start() {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("这个环境不能录音");
      return;
    }
    const target = conversationId;
    if (!target || starting.current || rec.current) return;
    starting.current = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (alive.current) setError("没有麦克风权限");
      return;
    } finally {
      starting.current = false;
    }
    // 授权弹窗回来时已经离开了：马上释放麦克风，不开始录
    if (!alive.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const mime = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m));
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      if (entry.cancelled || !alive.current) return;
      const blob = new Blob(chunks, { type: recorder.mimeType });
      if (blob.size === 0) return setState("idle");
      if (blob.size > CHAT_LIMITS.voiceImportMaxBytes) {
        setError("录音太大了");
        return setState("idle");
      }
      setState("sending");
      const format = recorder.mimeType.includes("ogg") ? "ogg" : "webm";
      await actions.chat.media.importVoice(target, format, await toBase64(blob));
      if (alive.current) setState("idle");
    };
    const started = Date.now();
    const timer = setInterval(() => {
      const ms = Date.now() - started;
      setElapsed(ms);
      if (ms >= CHAT_LIMITS.voiceMaxMs) stop();
    }, 250);
    const entry = { recorder, stream, started, timer, cancelled: false };
    rec.current = entry;
    recorder.start();
    setElapsed(0);
    setState("recording");
  }

  function stop() {
    const r = rec.current;
    if (!r) return;
    clearInterval(r.timer);
    if (r.recorder.state !== "inactive") r.recorder.stop();
    rec.current = null;
  }

  return (
    <>
      <button
        type="button"
        className="tool-button"
        data-recording={state === "recording" || undefined}
        disabled={disabled || state === "sending"}
        aria-pressed={state === "recording"}
        title={state === "recording" ? "再按一下停止" : "录一段语音（在主控机本地转写成文字再发）"}
        onClick={() => (state === "recording" ? stop() : void start())}
      >
        {state === "recording" ? (
          <>
            <span className="rec-dot" aria-hidden="true" />
            {durationText(elapsed)} 停
          </>
        ) : state === "sending" ? (
          "上传中…"
        ) : (
          "🎤 语音"
        )}
      </button>
      {error && <span className="field-error">{error}</span>}
    </>
  );
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** 表情面板：点一个就发出去；可以加、可以删（已经发出去的不受影响） */
export function StickerPanel({ onClose }: { onClose: () => void }) {
  const stickers = useAppState((s) => s.chat.media.stickers);
  const actions = useActions();
  const [label, setLabel] = useState("");
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (stickers === null) void actions.chat.media.loadStickers();
  }, [stickers, actions]);
  const add = () => {
    if (!label.trim()) return;
    void actions.chat.media.addSticker(label.trim());
    setLabel("");
  };
  return (
    <div className="sticker-panel" role="dialog" aria-label="表情">
      {stickers === null ? (
        <p className="chat-note">正在读取…</p>
      ) : stickers.length === 0 ? (
        <p className="chat-note">表情库是空的。在下面起个名字，再选一张静态图片（png / jpeg / webp，没有 GIF）。</p>
      ) : (
        <ul>
          {stickers.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                title={s.label}
                onClick={() => {
                  if (editing) return;
                  onClose();
                  void actions.chat.sendSticker(s.id);
                }}
              >
                <img src={imageSrc(s.image)} alt={s.label} />
              </button>
              {editing && (
                <button type="button" className="sticker-remove" aria-label={`删掉表情 ${s.label}`} onClick={() => void actions.chat.media.removeSticker(s.id)}>
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {/* 面板在输入框的 form 里面，这里不能再套 form：回车和按钮都走 add() */}
      <div className="chat-input-row">
        <input
          value={label}
          maxLength={40}
          placeholder="新表情的说明，例如：小鲸鱼比心"
          aria-label="新表情的说明"
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            add();
          }}
        />
        <button type="button" className="button-outline" disabled={!label.trim()} onClick={add}>
          选图加入
        </button>
        {stickers && stickers.length > 0 && (
          <button type="button" className="button-quiet" onClick={() => setEditing((v) => !v)}>
            {editing ? "完成" : "管理"}
          </button>
        )}
      </div>
      <p className="chat-note">秘书收到的是「[表情：说明]」，看不到图。</p>
    </div>
  );
}
