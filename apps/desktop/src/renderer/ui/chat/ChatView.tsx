import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { CHAT_LIMITS, type AgentChatMessage, type ChatMessage, type ChatReplySlot, type ChatRun, type Conversation, type UserChatMessage } from "@room/schemas";
import {
  MEMORY_STATUS_LABEL,
  canReedit,
  canRetract,
  canRetrySlot,
  contentText,
  conversationTitle,
  currentConversation,
  draftOf,
  memoryBadge,
  mentionHint,
  messageText,
  partialReplyText,
  previewText,
  runningSlots,
  selectableForTopic,
  shortTime,
  slotLabel,
  timeline,
  visibleSlots,
  type TimelineEntry,
} from "../../lib/chat";
import { agentColor, agentName } from "../../lib/discussion";
import { stripCharts } from "../../lib/media";
import { draftContent } from "../../lib/chat-actions";
import { ReplyBody } from "../Chart";
import { useActions, useAppState } from "../hooks";
import {
  AgentMedia,
  AttachmentTray,
  DrawSheetBody,
  ImmersiveSection,
  MediaHead,
  RecordButton,
  UserDraws,
  ImagesSeenLine,
  SpeechPlayer,
  StickerPanel,
  UserContent,
  VoiceDraft,
} from "./ChatMedia";

/**
 * 聊天空间（C-35）。按手机宽度设计：窄屏一次只显示一栏（会话列表 ↔ 会话），宽屏是同样的两栏放宽。
 * 聊天不盖章，所以这里没有朱红；要变成动作只能「转成议题」去讨论室。
 */
export function ChatView({ notice }: { notice: ReactNode }) {
  const available = useAppState((s) => s.chat.available);
  const open = useAppState((s) => s.chat.currentId !== null);
  const sheet = useAppState((s) => s.chat.sheet);
  if (!available) {
    return (
      <main className="chat-unavailable">
        {notice}
        <h1>聊天还没上线</h1>
        <p>后端还不认识聊天的命令。讨论室照常可用。</p>
      </main>
    );
  }
  return (
    <div className="chat" data-open={open ? "conversation" : "list"}>
      <ConversationList />
      <main className="chat-pane">
        {notice}
        {open ? <ConversationPane /> : <p className="chat-pane-empty">从左边选一个会话，或者新建一个。</p>}
      </main>
      {sheet?.kind === "new" && <NewConversationSheet />}
      {sheet?.kind === "settings" && <SettingsSheet />}
      {sheet?.kind === "message" && <MessageSheet messageId={sheet.messageId} />}
      {sheet?.kind === "draw" && <DrawSheet messageId={sheet.messageId} prompt={sheet.prompt} />}
      <SpeechPlayer />
    </div>
  );
}

// ------------------------------------------------------------ 小工具

/** 每 15 秒刷新一次「现在」，撤回 / 重新编辑的时间窗口用（只是显示，后端按主控机时间判断） */
function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function useNames() {
  const disc = useAppState((s) => s.disc);
  return { name: (id: string) => agentName(disc, id), color: (id: string) => agentColor(disc, id) };
}

const agentStyle = (color: string) => ({ "--agent": color }) as CSSProperties;

function Avatar({ label, color }: { label: string; color: string }) {
  return (
    <span className="avatar" aria-hidden="true" style={agentStyle(color)}>
      {label.slice(0, 1)}
    </span>
  );
}

/** 群头像（画布草案）：成员的头像拼成 2×2 小方格，最多 4 格，不够的空着 */
function GroupAvatar({ members, name, color }: { members: readonly string[]; name: (id: string) => string; color: (id: string) => string }) {
  const cells = members.slice(0, 4);
  return (
    <span className="avatar avatar-group" aria-hidden="true">
      {[0, 1, 2, 3].map((i) =>
        cells[i] === undefined ? (
          <span key={i} className="avatar-cell avatar-cell-empty" />
        ) : (
          <span key={i} className="avatar-cell" style={agentStyle(color(cells[i]!))}>
            {name(cells[i]!).slice(0, 1)}
          </span>
        ),
      )}
    </span>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const esc = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="chat-sheet-backdrop" onClick={onClose}>
      <section className="chat-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="chat-sheet-head">
          <h2>{title}</h2>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

// ------------------------------------------------------------ 会话列表

function ConversationList() {
  const list = useAppState((s) => s.chat.list);
  const currentId = useAppState((s) => s.chat.currentId);
  const actions = useActions();
  const { name, color } = useNames();
  const now = useNow(60_000);
  return (
    <nav className="chat-list" aria-label="会话">
      <header className="chat-list-head">
        <h1>聊天</h1>
        <button type="button" className="icon-button" aria-label="新建会话" onClick={() => actions.chat.openSheet({ kind: "new" })}>
          +
        </button>
      </header>
      {list === null ? (
        <p className="chat-list-empty">正在读取…</p>
      ) : list.length === 0 ? (
        <p className="chat-list-empty">还没有会话。点右上角的 + 和一位秘书单聊，或者拉几位建群。</p>
      ) : (
        <ul>
          {list.map(({ conversation: conv, lastMessage, unreadCount, runningSlots }) => {
            const title = conversationTitle(conv, name);
            return (
              <li key={conv.id}>
                <button
                  type="button"
                  className="chat-list-item"
                  aria-current={conv.id === currentId ? "page" : undefined}
                  data-pinned={conv.pinned || undefined}
                  onClick={() => void actions.chat.openConversation(conv.id)}
                >
                  {conv.kind === "group" ? (
                    <GroupAvatar members={conv.members} name={name} color={color} />
                  ) : (
                    <Avatar label={name(conv.members[0]!)} color={color(conv.members[0]!)} />
                  )}
                  <span className="chat-list-main">
                    <span className="chat-list-title">
                      <b>{title}</b>
                      {conv.kind === "group" && <span className="chat-list-count">（{conv.members.length + 1}）</span>}
                      <span className="spacer" />
                      <time dateTime={conv.lastActivityAt}>{shortTime(conv.lastActivityAt, now)}</time>
                    </span>
                    <span className="chat-list-preview">
                      {runningSlots > 0 ? <em>{runningSlots} 位回答中…</em> : previewText(lastMessage, name)}
                      <span className="spacer" />
                      {conv.muted && <span className="chat-muted" title="免打扰">🔕</span>}
                      {unreadCount > 0 &&
                        (conv.muted ? (
                          <span className="chat-dot" aria-label="有未读" />
                        ) : (
                          <span className="chat-badge" aria-label={`${unreadCount} 条未读`}>
                            {unreadCount > 99 ? "99+" : unreadCount}
                          </span>
                        ))}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}

// ------------------------------------------------------------ 会话

function ConversationPane() {
  const conv = useAppState((s) => currentConversation(s.chat));
  const selecting = useAppState((s) => s.chat.selecting);
  const actions = useActions();
  const { name } = useNames();
  if (!conv) return <p className="chat-pane-empty">正在读取…</p>;
  return (
    <>
      <header className="chat-head">
        <button type="button" className="icon-button chat-back" aria-label="返回会话列表" onClick={actions.chat.closeConversation}>
          ‹
        </button>
        <h2>
          {conversationTitle(conv, name)}
          {conv.kind === "group" && <span className="chat-list-count">（{conv.members.length + 1}）</span>}
        </h2>
        <span className="spacer" />
        <MediaHead />
        <button type="button" className="icon-button" aria-label="会话设置" onClick={() => actions.chat.openSheet({ kind: "settings" })}>
          ⋯
        </button>
      </header>
      <Timeline conv={conv} />
      {selecting ? <SelectBar count={selecting.length} /> : <Composer conv={conv} />}
    </>
  );
}

function Timeline({ conv }: { conv: Conversation }) {
  const entries = useAppState((s) => timeline(s.chat));
  const live = useAppState((s) => runningSlots(s.chat));
  const hasOlder = useAppState((s) => s.chat.nextCursor !== null);
  const runEvents = useAppState((s) => s.runEvents);
  const actions = useActions();
  const { name, color } = useNames();
  const now = useNow();
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const liveText = live.map((sl) => (sl.runId ? (runEvents[sl.runId] ?? []).map((e) => (e.type === "message_delta" ? e.text : "")).join("") : ""));

  // 停在底部时，新消息和流式文字自动跟上；往上翻着看的时候不打扰
  const lastKey = `${entries.length}:${liveText.join("").length}:${live.length}`;
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lastKey, conv.id]);

  return (
    <div
      className="chat-timeline"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
    >
      {hasOlder && (
        <button type="button" className="button-link chat-older" onClick={() => void actions.chat.loadOlder()}>
          加载更早的消息
        </button>
      )}
      {entries.length === 0 && live.length === 0 && (
        <p className="chat-timeline-empty">
          {conv.kind === "direct" ? `和 ${name(conv.members[0]!)} 说点什么吧。` : "在群里说话时，打 @ 可以点名谁必须回答；不点名每位自己决定回不回。"}
        </p>
      )}
      <ol>
        {entries.map((e) => (
          <Entry key={e.message.id} entry={e} now={now} conv={conv} />
        ))}
        {live.map((sl, i) => {
          const text = partialReplyText(liveText[i] ?? "");
          return (
            <li key={sl.id} className="chat-row" data-side="agent">
              <Avatar label={name(sl.agent)} color={color(sl.agent)} />
              <div className="chat-bubble-wrap" style={agentStyle(color(sl.agent))}>
                <div className="chat-meta">
                  <b>{name(sl.agent)}</b> · 回答中
                  <button type="button" className="button-link" onClick={() => void actions.chat.cancelReply(sl.id)}>
                    停
                  </button>
                </div>
                <div className="chat-bubble" data-live="true">
                  {text ? <p className="chat-text">{text}<span className="cursor" aria-hidden="true">▍</span></p> : <p className="chat-thinking">正在想…</p>}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Entry({ entry, now, conv }: { entry: TimelineEntry; now: number; conv: Conversation }) {
  const selecting = useAppState((s) => s.chat.selecting);
  const messages = useAppState((s) => s.chat.messages);
  const actions = useActions();
  const { name, color } = useNames();
  const m = entry.message;

  if (entry.kind === "retracted") {
    const rm = entry.message;
    return (
      <li className="chat-system">
        你撤回了一条消息
        {canReedit(rm, messages, now) && rm.content.kind === "text" && (
          <>
            {" · "}
            <button type="button" className="button-link" onClick={() => actions.chat.startReedit(rm.id)}>
              重新编辑
            </button>
          </>
        )}
        {" · "}
        <button type="button" className="button-link" onClick={() => actions.chat.openSheet({ kind: "message", messageId: rm.id })}>
          原文
        </button>
      </li>
    );
  }

  const selectable = selectableForTopic(m, messages);
  const selected = selecting?.includes(m.id) ?? false;
  const check = selecting && (
    <input
      type="checkbox"
      className="chat-check"
      aria-label="选中这条"
      checked={selected}
      disabled={!selectable}
      title={selectable ? undefined : "已撤回的消息和它的回答不能转成议题"}
      onChange={() => actions.chat.toggleSelect(m.id)}
    />
  );

  if (entry.kind === "agent") {
    const am = entry.message;
    const badge = memoryBadge(am);
    return (
      <li className="chat-row" data-side="agent" data-excluded={entry.excluded || undefined}>
        {check}
        <Avatar label={name(am.agent)} color={color(am.agent)} />
        <div className="chat-bubble-wrap" style={agentStyle(color(am.agent))}>
          <div className="chat-meta">
            <b>{name(am.agent)}</b> · {shortTime(am.createdAt, now)}
            {badge && (
              <button
                type="button"
                className="chat-memory"
                title="这次回答用到的记忆来源"
                onClick={() => actions.chat.openSheet({ kind: "message", messageId: am.id })}
              >
                {badge}
              </button>
            )}
          </div>
          {entry.replyTo && <QuoteLine message={entry.replyTo} prefix="回复" />}
          <MessageMenu message={am} now={now}>
            <div className="chat-bubble">
              <ReplyBody text={am.text} />
            </div>
          </MessageMenu>
          {!entry.excluded && <AgentMedia message={am} conv={conv} />}
          {entry.excluded && <p className="chat-note">你撤回了提问，这条回答之后不再发给秘书</p>}
        </div>
      </li>
    );
  }

  const um = entry.message;
  const quoted = um.quoteMessageId ? messages.find((x) => x.id === um.quoteMessageId) : undefined;
  return (
    <li className="chat-row" data-side="user">
      {check}
      <div className="chat-bubble-wrap">
        <div className="chat-meta">
          {shortTime(um.createdAt, now)}
          {entry.reedited && <span className="tag">已重新编辑</span>}
          {um.replyAsVoice && <span className="tag" title="这条的回答会合成语音">要语音回</span>}
          <Mentions message={um} />
        </div>
        {quoted && <QuoteLine message={quoted} prefix="引用" />}
        <MessageMenu message={um} now={now}>
          <UserContent message={um} />
        </MessageMenu>
        <ImagesSeenLine message={um} slots={entry.slots} />
        {um.state !== "retracted" && <UserDraws message={um} conv={conv} />}
        <SlotLine slots={entry.slots} />
      </div>
    </li>
  );
}

function Mentions({ message }: { message: UserChatMessage }) {
  const { name } = useNames();
  if (message.mentions.kind === "none") return null;
  return <span className="chat-mentions">@{message.mentions.kind === "all" ? "所有人" : message.mentions.agents.map(name).join(" @")}</span>;
}

function QuoteLine({ message, prefix }: { message: ChatMessage; prefix: string }) {
  const { name } = useNames();
  const who = message.sender === "user" ? "你" : name(message.agent);
  const text = message.sender === "user" && message.state === "retracted" ? "（已撤回）" : stripCharts(messageText(message));
  return (
    <p className="chat-quote">
      {prefix} {who}：{text.replace(/\s+/g, " ").slice(0, 60)}
    </p>
  );
}

/** 你的消息下面：没答上的回答位（这条没有回 / 失败 / 额度缺席 / 不能回答 / 已停止），失败的可以单独重试 */
function SlotLine({ slots }: { slots: ChatReplySlot[] }) {
  const actions = useActions();
  const { name } = useNames();
  const shown = visibleSlots(slots).filter((s) => s.outcome !== "retracted");
  if (!shown.length) return null;
  return (
    <ul className="chat-slots">
      {shown.map((s) => (
        <li key={s.id} data-outcome={s.outcome} title={s.failure?.message}>
          {name(s.agent)} · {slotLabel(s)}
          {canRetrySlot(s) && (
            <button type="button" className="button-link" onClick={() => void actions.chat.retry(s.id)}>
              重试
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 消息菜单：点「⋯」、右键或长按打开。复制 / 引用 / 多选 / 撤回 / 详情 */
function MessageMenu({ message, now, children }: { message: ChatMessage; now: number; children: ReactNode }) {
  const messages = useAppState((s) => s.chat.messages);
  const selecting = useAppState((s) => s.chat.selecting);
  const actions = useActions();
  const [open, setOpen] = useState(false);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPress = () => {
    if (press.current) clearTimeout(press.current);
    press.current = null;
  };
  useEffect(() => clearPress, []);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  if (selecting) return <>{children}</>;
  const usable = selectableForTopic(message, messages);
  const item = (label: string, run: () => void, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        setOpen(false);
        run();
      }}
    >
      {label}
    </button>
  );
  return (
    <div
      className="chat-menu-anchor"
      onContextMenu={(e) => {
        e.preventDefault();
        setOpen(true);
      }}
      onPointerDown={(e) => {
        if (e.pointerType !== "touch") return;
        clearPress();
        press.current = setTimeout(() => setOpen(true), 500);
      }}
      onPointerUp={clearPress}
      onPointerLeave={clearPress}
      onPointerCancel={clearPress}
    >
      {children}
      <button
        type="button"
        className="chat-menu-button"
        aria-label="消息操作"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ⋯
      </button>
      {open && (
        <div className="chat-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          {item("复制", () => void navigator.clipboard?.writeText(messageText(message)))}
          {item("引用", () => actions.chat.quote(message.id), !usable)}
          {item("多选", () => actions.chat.startSelect(message.id), !usable)}
          {item("照这条画一张", () => actions.chat.media.openDrawCard(message.id, stripCharts(messageText(message)).slice(0, 1000)), !usable)}
          {canRetract(message, now) && item("撤回", () => void actions.chat.retract(message.id))}
          {item("详情", () => actions.chat.openSheet({ kind: "message", messageId: message.id }))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ 输入框

function Composer({ conv }: { conv: Conversation }) {
  const draft = useAppState((s) => draftOf(s.chat, s.chat.currentId));
  const messages = useAppState((s) => s.chat.messages);
  const importing = useAppState((s) => s.chat.media.voiceImporting[conv.id] === true);
  const actions = useActions();
  const { name } = useNames();
  const [picker, setPicker] = useState(false);
  const [stickers, setStickers] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const quoted = draft.quoteMessageId ? messages.find((m) => m.id === draft.quoteMessageId) : undefined;
  const isGroup = conv.kind === "group";
  const tooLong = draft.text.length > CHAT_LIMITS.textMaxChars;
  const tooManyImages = draft.attachments.filter((a) => a.kind === "image").length > CHAT_LIMITS.imagesPerMessage;
  const tooManyFiles = draft.attachments.length >= CHAT_LIMITS.attachmentsPerMessage;
  const canSend = draftContent(draft) !== null && !tooLong && !tooManyImages;

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSend) return;
    setPicker(false);
    setStickers(false);
    void actions.chat.send();
  };

  /** 在 @ 选择框里选了一项：把刚打的「@」补成「@名字 」（只是给人看的），结构化的点名才算数 */
  const pick = (who: "all" | string) => {
    const el = input.current;
    const label = who === "all" ? "所有人" : name(who);
    const pos = el?.selectionStart ?? draft.text.length;
    const before = draft.text.slice(0, pos);
    const text = before.endsWith("@") ? `${before}${label} ${draft.text.slice(pos)}` : draft.text;
    actions.chat.setDraftText(text);
    const already = who === "all" ? draft.mentions.kind === "all" : draft.mentions.kind === "agents" && draft.mentions.agents.includes(who);
    if (!already) actions.chat.toggleMention(who);
    setPicker(false);
    requestAnimationFrame(() => el?.focus());
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法选字时的回车不算发送
    if (e.nativeEvent.isComposing) return;
    if (picker && e.key === "Escape") {
      e.preventDefault();
      setPicker(false);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <form className="chat-composer" onSubmit={send}>
      {draft.replacesMessageId && (
        <p className="chat-composer-bar">
          重新编辑：发出去是一条新消息，显示在原来的位置
          <button type="button" className="button-link" onClick={actions.chat.cancelReedit}>
            取消
          </button>
        </p>
      )}
      {quoted && (
        <p className="chat-composer-bar">
          <span className="chat-composer-quote">
            引用 {quoted.sender === "user" ? "你" : name(quoted.agent)}：{stripCharts(messageText(quoted)).replace(/\s+/g, " ").slice(0, 60)}
          </span>
          <button type="button" className="button-link" onClick={() => actions.chat.quote(null)}>
            取消
          </button>
        </p>
      )}
      {isGroup && draft.mentions.kind !== "none" && (
        <ul className="chat-chips" aria-label="点名">
          {(draft.mentions.kind === "all" ? ["all"] : draft.mentions.agents).map((who) => (
            <li key={who}>
              @{who === "all" ? "所有人" : name(who)}
              <button type="button" aria-label={`取消点名 ${who === "all" ? "所有人" : name(who)}`} onClick={() => actions.chat.toggleMention(who)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <AttachmentTray conv={conv} />
      <VoiceDraft />
      {stickers && <StickerPanel onClose={() => setStickers(false)} />}
      <div className="chat-tools" role="toolbar" aria-label="附件和语音">
        <button type="button" className="tool-button" disabled={!!draft.voice || importing || tooManyFiles} onClick={() => void actions.chat.media.pickAttachment("image")}>
          🖼 图片
        </button>
        <button type="button" className="tool-button" disabled={!!draft.voice || importing || tooManyFiles} onClick={() => void actions.chat.media.pickAttachment("file")}>
          📎 文件
        </button>
        <RecordButton key={conv.id} disabled={!!draft.voice || importing || draft.attachments.length > 0} />
        <button type="button" className="tool-button" aria-expanded={stickers} onClick={() => setStickers((v) => !v)}>
          ☺ 表情
        </button>
        <span className="spacer" />
        <label className="voice-toggle" title="打开后，这条消息的回答都会用语音发（在主控机本地合成）。你在话里说「用语音回我」也会自动打开">
          <input type="checkbox" checked={draft.replyAsVoice} onChange={(e) => actions.chat.media.setReplyAsVoice(e.target.checked)} />
          用语音回
        </label>
      </div>
      <div className="chat-input-row" hidden={!!draft.voice}>
        <textarea
          ref={input}
          rows={1}
          value={draft.text}
          placeholder={isGroup ? "说点什么，打 @ 点名" : "说点什么"}
          aria-label="消息"
          onChange={(e) => {
            const text = e.target.value;
            const pos = e.target.selectionStart ?? text.length;
            actions.chat.setDraftText(text);
            // 刚打了一个 @ 就弹出成员选择
            if (isGroup && text.length > draft.text.length && text[pos - 1] === "@") setPicker(true);
          }}
          onKeyDown={onKey}
        />
        <button type="submit" className="button-primary" disabled={!canSend}>
          发送
        </button>
        {picker && isGroup && (
          <div className="chat-picker" role="listbox" aria-label="点名谁必须回答">
            <button type="button" role="option" aria-selected={draft.mentions.kind === "all"} onClick={() => pick("all")}>
              所有人
            </button>
            {conv.members.map((a) => (
              <button
                key={a}
                type="button"
                role="option"
                aria-selected={draft.mentions.kind === "agents" && draft.mentions.agents.includes(a)}
                onClick={() => pick(a)}
              >
                {name(a)}
              </button>
            ))}
            <button type="button" className="chat-picker-close" onClick={() => setPicker(false)}>
              不点名
            </button>
          </div>
        )}
      </div>
      {draft.voice && (
        <div className="chat-input-row chat-voice-send">
          <span className="spacer" />
          <button type="button" className="button-primary" disabled={!canSend} onClick={() => send()}>
            发送语音
          </button>
        </div>
      )}
      <p className="chat-hint">
        {draft.replyAsVoice && "这条的回答会用语音发 · "}
        {tooLong ? <span className="field-error">太长了：最多 {CHAT_LIMITS.textMaxChars} 字</span> : mentionHint(conv, isGroup ? draft.mentions : { kind: "none" }, name)}
        {isGroup && draft.mentions.kind === "none" && /@\S/.test(draft.text) && " · 正文里打的 @ 不算点名，要从弹出的列表里选"}
      </p>
    </form>
  );
}

// ------------------------------------------------------------ 多选 → 转议题

function SelectBar({ count }: { count: number }) {
  const actions = useActions();
  const firstText = useAppState((s) => {
    const first = s.chat.messages.find((m) => s.chat.selecting?.includes(m.id));
    return first ? messageText(first).replace(/\s+/g, " ").slice(0, 30) : "";
  });
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const value = touched ? name : firstText;
  const tooMany = count > CHAT_LIMITS.toTopicMaxMessages;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!count || !value.trim() || tooMany) return;
    void actions.chat.toTopic(value.trim());
  };
  return (
    <form className="chat-selectbar" onSubmit={submit}>
      <p>
        已选 {count} 条{tooMany && <span className="field-error">（最多 {CHAT_LIMITS.toTopicMaxMessages} 条）</span>}。转成议题后，这些消息作为初始材料，之后照讨论室流程盖章才会发出去。
      </p>
      <div className="chat-input-row">
        <input
          value={value}
          maxLength={200}
          placeholder="议题名称"
          aria-label="议题名称"
          onChange={(e) => {
            setTouched(true);
            setName(e.target.value);
          }}
        />
        <button type="submit" className="button-primary" disabled={!count || !value.trim() || tooMany}>
          转成议题
        </button>
        <button type="button" className="button-quiet" onClick={actions.chat.cancelSelect}>
          取消
        </button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------ 浮层

function NewConversationSheet() {
  const agents = useAppState((s) => s.disc.agents);
  const actions = useActions();
  const [picked, setPicked] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const tooMany = picked.length > CHAT_LIMITS.maxRecipients;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!picked.length || tooMany) return;
    const members = picked.length === 1 ? { kind: "direct" as const, agent: picked[0]! } : { kind: "group" as const, agents: picked };
    void actions.chat.createConversation(members, title.trim() || null);
  };
  return (
    <Sheet title="新建会话" onClose={actions.chat.closeSheet}>
      <form className="chat-sheet-body" onSubmit={submit}>
        <fieldset>
          <legend>和谁聊（选一位是单聊，选几位是群聊）</legend>
          {agents.map((a) => (
            <label key={a.id} className="chat-member" style={agentStyle(a.color)}>
              <input
                type="checkbox"
                checked={picked.includes(a.id)}
                onChange={() => setPicked((p) => (p.includes(a.id) ? p.filter((x) => x !== a.id) : [...p, a.id]))}
              />
              <Avatar label={a.displayName} color={a.color} />
              {a.displayName}
            </label>
          ))}
        </fieldset>
        <label className="chat-field">
          名字（可以不填）
          <input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} placeholder={picked.length > 1 ? "比如：三位秘书" : "备注名"} />
        </label>
        {tooMany && <p className="field-error">群聊最多 {CHAT_LIMITS.maxRecipients} 位</p>}
        <button type="submit" className="button-primary" disabled={!picked.length || tooMany}>
          {picked.length > 1 ? "建群聊" : "开始单聊"}
        </button>
      </form>
    </Sheet>
  );
}

function SettingsSheet() {
  const conv = useAppState((s) => currentConversation(s.chat));
  const agents = useAppState((s) => s.disc.agents);
  const actions = useActions();
  const { name } = useNames();
  const [title, setTitle] = useState(conv?.title ?? "");
  const [members, setMembers] = useState<string[]>(conv?.members ?? []);
  if (!conv) return null;
  const membersChanged = members.length !== conv.members.length || members.some((m) => !conv.members.includes(m));
  const membersOk = members.length >= 2 && members.length <= CHAT_LIMITS.maxRecipients;
  return (
    <Sheet title={conversationTitle(conv, name)} onClose={actions.chat.closeSheet}>
      <div className="chat-sheet-body">
        <form
          className="chat-field-row"
          onSubmit={(e) => {
            e.preventDefault();
            void actions.chat.updateConversation({ title: title.trim() || null });
          }}
        >
          <label className="chat-field">
            {conv.kind === "group" ? "群名" : "备注名"}
            <input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} placeholder={conversationTitle({ ...conv, title: null }, name)} />
          </label>
          <button type="submit" className="button-outline" disabled={(title.trim() || null) === conv.title}>
            保存
          </button>
        </form>
        <label className="chat-toggle">
          <input type="checkbox" checked={conv.pinned} onChange={(e) => void actions.chat.updateConversation({ pinned: e.target.checked })} />
          置顶
        </label>
        <label className="chat-toggle">
          <input type="checkbox" checked={conv.muted} onChange={(e) => void actions.chat.updateConversation({ muted: e.target.checked })} />
          免打扰（不弹通知，未读只显示小红点）
        </label>
        {conv.kind === "group" && (
          <fieldset>
            <legend>成员（2～{CHAT_LIMITS.maxRecipients} 位）</legend>
            {agents.map((a) => (
              <label key={a.id} className="chat-member" style={agentStyle(a.color)}>
                <input
                  type="checkbox"
                  checked={members.includes(a.id)}
                  onChange={() => setMembers((p) => (p.includes(a.id) ? p.filter((x) => x !== a.id) : [...p, a.id]))}
                />
                <Avatar label={a.displayName} color={a.color} />
                {a.displayName}
              </label>
            ))}
            <p className="chat-note">移出的人正在答的照常答完，之后的消息不再发给他。</p>
            <button
              type="button"
              className="button-outline"
              disabled={!membersChanged || !membersOk}
              onClick={() => void actions.chat.updateConversation({ members })}
            >
              保存成员
            </button>
          </fieldset>
        )}
        <ImmersiveSection />
        <button type="button" className="button-outline" onClick={() => actions.chat.startSelect()}>
          多选消息，转成议题
        </button>
      </div>
    </Sheet>
  );
}

function DrawSheet({ messageId, prompt }: { messageId: string; prompt: string }) {
  const conv = useAppState((s) => currentConversation(s.chat));
  const actions = useActions();
  if (!conv) return null;
  return (
    <Sheet title="画一张图" onClose={actions.chat.closeSheet}>
      <DrawSheetBody messageId={messageId} prompt={prompt} conv={conv} />
    </Sheet>
  );
}

function MessageSheet({ messageId }: { messageId: string }) {
  const m = useAppState((s) => s.chat.messages.find((x) => x.id === messageId));
  const run = useAppState((s) => (m?.sender === "agent" ? s.chat.runs[m.runId] : undefined));
  const actions = useActions();
  const { name } = useNames();
  useEffect(() => {
    if (m?.sender === "agent") void actions.chat.loadChatRun(m.runId);
  }, [m, actions]);
  if (!m) return null;
  return (
    <Sheet title="消息详情" onClose={actions.chat.closeSheet}>
      <div className="chat-sheet-body">
        <p className="chat-note">
          {m.sender === "user" ? "你" : name(m.agent)} · {new Date(m.createdAt).toLocaleString()}
        </p>
        {m.sender === "user" && m.state === "retracted" && (
          <p className="chat-note">
            已撤回：之后发给秘书的内容都不再带它。已经发出去的（秘书当时已经看到的）收不回来。
          </p>
        )}
        <pre className="chat-detail-text">{messageText(m)}</pre>
        {m.sender === "user" && m.content.kind === "voice" && (
          <p className="chat-note">
            转写：{m.content.transcript.engine.engine} / {m.content.transcript.engine.model}
            {m.content.transcript.source === "edited" ? "，发送前你改过" : ""}
          </p>
        )}
        {m.sender === "agent" && <MemoryDetail message={m} run={run} />}
      </div>
    </Sheet>
  );
}

function MemoryDetail({ message, run }: { message: AgentChatMessage; run: ChatRun | undefined }) {
  const manifest = run?.memoryManifest;
  return (
    <section className="chat-memory-detail">
      <h3>记忆来源</h3>
      <ul>
        <li>本会话的聊天记录（较早的用摘要）</li>
        {message.memoryEntriesUsed === null ? (
          <li>节点记忆文件夹：这位没有开</li>
        ) : run === undefined ? (
          <li>节点记忆文件夹：正在读取…</li>
        ) : manifest ? (
          <li>
            节点记忆文件夹：{MEMORY_STATUS_LABEL[manifest.status]}
            {manifest.entries.length > 0 && (
              <ul>
                {manifest.entries.map((e) => (
                  <li key={e.id}>
                    <code>{e.id}</code>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ) : (
          <li>节点记忆文件夹：节点没有回报</li>
        )}
      </ul>
      <p className="chat-note">主控端只记用了哪几条，不存记忆正文。</p>
    </section>
  );
}
