import { Fragment, useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
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
  mentionsFromText,
  agentTitle,
  timeBreaks,
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
import { Icon, type IconName } from "../Icon";
import { RECOMMENDED_NODES } from "../../lib/presets";
import {
  REJECT_LABEL,
  compactionText,
  handoffPhase,
  noteTimelineText,
  notesBySource,
  rejectedBySource,
  suggestedSwitches,
  windowLinesAfter,
} from "../../lib/notes";
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
  const name = (id: string) => agentName(disc, id);
  /** 草案：「C酱 · 首席秘书」 */
  const nameWithTitle = (id: string) => {
    const title = agentTitle(disc.agents.find((a) => a.id === id)?.roleNote ?? "");
    return title ? `${name(id)} · ${title}` : name(id);
  };
  return { name, nameWithTitle, color: (id: string) => agentColor(disc, id) };
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
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  // 草案：列表上面一个搜索框。只在已经读到的会话里找名字和最后一条，不另外查后端
  const shown =
    list && q
      ? list.filter(({ conversation: conv, lastMessage }) => `${conversationTitle(conv, name)} ${previewText(lastMessage, name)}`.toLowerCase().includes(q))
      : list;
  return (
    <nav className="chat-list" aria-label="会话">
      <header className="chat-list-head">
        <h1>聊天</h1>
        <button type="button" className="icon-button" aria-label="新建会话" onClick={() => actions.chat.openSheet({ kind: "new" })}>
          +
        </button>
      </header>
      <label className="chat-search">
        <Icon name="search" size={16} />
        <input type="search" value={query} placeholder="搜索" aria-label="搜索聊天" onChange={(e) => setQuery(e.target.value)} />
      </label>
      {list === null ? (
        <p className="chat-list-empty">正在读取…</p>
      ) : list.length === 0 ? (
        <p className="chat-list-empty">还没有会话。点右上角的 + 和一位秘书单聊，或者拉几位建群。</p>
      ) : shown!.length === 0 ? (
        <p className="chat-list-empty">没有找到「{query.trim()}」</p>
      ) : (
        <ul>
          {shown!.map(({ conversation: conv, lastMessage, unreadCount, runningSlots }) => {
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
      <p className="chat-list-tip">聊天里只说话，不改文件。聊出想做的事，长按消息「转成议题」。</p>
    </nav>
  );
}

// ------------------------------------------------------------ 会话

function ConversationPane() {
  const conv = useAppState((s) => currentConversation(s.chat));
  const selecting = useAppState((s) => s.chat.selecting);
  const answering = useAppState((s) => runningSlots(s.chat).map((sl) => sl.agent));
  const agents = useAppState((s) => s.disc.agents);
  const actions = useActions();
  const { name } = useNames();
  // 笔记和每位的窗口状态（C-47）：打开会话时读一次，之后靠事件
  const convId = conv?.id;
  useEffect(() => {
    if (convId) void actions.notes.loadConversation(convId);
  }, [convId, actions]);
  if (!conv) return <p className="chat-pane-empty">正在读取…</p>;
  const direct = conv.kind === "direct" ? agents.find((a) => a.id === conv.members[0]) : undefined;
  const who = [...new Set(answering)];
  // 草案：标题下一行小字。有人在答就写谁在答；单聊平时写「身份 · 在哪台电脑」
  const sub = who.length
    ? `${who.map(name).join("、")} 正在回答`
    : direct
      ? [agentTitle(direct.roleNote), nodeLabel(direct.nodeId)].filter(Boolean).join(" · ")
      : "";
  return (
    <>
      <header className="chat-head">
        <button type="button" className="icon-button chat-back" aria-label="返回会话列表" onClick={actions.chat.closeConversation}>
          ‹
        </button>
        <div className="chat-head-title">
          <h2>
            {conversationTitle(conv, name)}
            {conv.kind === "group" && <span className="chat-list-count">（{conv.members.length + 1}）</span>}
          </h2>
          {sub && <p className="chat-head-sub">{sub}</p>}
        </div>
        <MediaHead />
        {!selecting && (
          <button type="button" className="button-pill chat-head-select" onClick={() => actions.chat.startSelect()}>
            多选转议题
          </button>
        )}
        <button type="button" className="icon-button" aria-label="会话设置" onClick={() => actions.chat.openSheet({ kind: "settings" })}>
          ⋯
        </button>
      </header>
      <MemoryBar conv={conv} />
      <Timeline conv={conv} />
      {selecting ? <SelectBar count={selecting.length} /> : <Composer conv={conv} />}
    </>
  );
}

/**
 * 聊天顶上的记忆条（C-47 / ADR-005 §4）：记忆来源、笔记、这个窗口压缩了几次、上下文 %（节点报的）。
 * 窗口里压缩满 3 次显示「建议换窗口」，只提醒不自动换；有没确认的交接笔记就给个入口接着看
 */
function MemoryBar({ conv }: { conv: Conversation }) {
  const agents = useAppState((s) => s.disc.agents);
  const status = useAppState((s) => s.disc.status);
  const notesOn = useAppState((s) => s.notes.available);
  const windows = useAppState((s) => (s.notes.windowsAvailable ? s.notes.windows[conv.id] : undefined));
  const latest = useAppState((s) => s.notes.latest[`c:${conv.id}`]);
  const runs = useAppState((s) => s.notes.handoffRuns);
  const actions = useActions();
  const { name } = useNames();
  const scope = { kind: "conversation" as const, conversationId: conv.id };
  const direct = conv.kind === "direct" ? agents.find((a) => a.id === conv.members[0]) : undefined;
  const openNotes = (agent: string) => actions.notes.openNote(scope, agent, conv.members);
  const pending = (windows ?? []).filter((w) => w.pendingDraft);
  const suggest = suggestedSwitches(windows).filter((w) => !w.pendingDraft);
  const draftChips = pending.map((w) => {
    const d = w.pendingDraft!;
    const phase = handoffPhase(d, d.runId ? runs[d.runId] : undefined);
    return (
      <button key={`d-${w.agent}`} type="button" className="chat-bar-chip" data-tone="active" onClick={() => void actions.notes.prepareWindow(conv.id, w.agent)}>
        {conv.kind === "group" ? `${name(w.agent)} ` : ""}
        {phase === "writing" ? "正在写交接笔记…" : phase === "failed" ? "交接没写成 · 看看" : "交接笔记写好了 · 看一下"}
      </button>
    );
  });
  const suggestChips = suggest.map((w) => (
    <button key={`s-${w.agent}`} type="button" className="chat-bar-chip" data-tone="warn" title={compactionText(w)} onClick={() => void actions.notes.prepareWindow(conv.id, w.agent)}>
      {conv.kind === "group" ? `${name(w.agent)} 压缩 ${w.compactionsInWindow} 次 · ` : ""}建议换窗口
    </button>
  ));

  if (direct) {
    const st = status[direct.id];
    const win = windows?.find((w) => w.agent === direct.id);
    const note = latest?.find((n) => n.agent === direct.id);
    return (
      <div className="chat-memory-bar">
        <Icon name="memory" size={15} />
        <span className="chat-memory-src">记忆：{direct.memorySource.nodeFolder ? `节点记忆文件夹（${nodeLabel(direct.nodeId)}）+ ` : ""}聊天记录</span>
        <span className="chat-memory-ro">只读</span>
        {notesOn && (
          <button type="button" className="chat-bar-chip" onClick={() => openNotes(direct.id)}>
            笔记{note ? ` v${note.version}` : ""} ›
          </button>
        )}
        {win && (
          <span className="chat-memory-ctx" title="主控机按这个会话、这个窗口里的历史摘要数的">
            {win.index > 1 ? `第 ${win.index} 个窗口 · ` : ""}{compactionText(win).replace("，建议换", "")}
          </span>
        )}
        {/* 上下文 % 还是节点按秘书报的那个数，不是单算这个会话的 */}
        {st?.contextUsedPercent != null && (
          <span className="chat-memory-ctx" title="这位秘书现在的上下文用量（节点报的，不是只算这个会话）">
            上下文 {Math.round(st.contextUsedPercent)}%（节点报的）
          </span>
        )}
        {suggestChips}
        {draftChips}
      </div>
    );
  }
  if (!notesOn && !suggestChips.length && !draftChips.length) return null;
  return (
    <div className="chat-memory-bar">
      <Icon name="memory" size={15} />
      {notesOn && (
        <button type="button" className="chat-bar-chip" onClick={() => openNotes(latest?.[0]?.agent ?? conv.members[0]!)}>
          笔记{latest?.length ? ` · ${latest.length} 位记了` : ""} ›
        </button>
      )}
      {suggestChips}
      {draftChips}
      {!suggestChips.length && !draftChips.length && <span className="chat-memory-ctx">每位的窗口在 ⋯ 设置里换</span>}
    </div>
  );
}

/** 节点 id → 给人看的名字（「主控机」「你的电脑」）；没配就写「未配置节点」 */
function nodeLabel(nodeId: string | null): string {
  if (nodeId === null) return "未配置节点";
  return RECOMMENDED_NODES.find((n) => n.id === nodeId)?.label ?? nodeId;
}

function Timeline({ conv }: { conv: Conversation }) {
  const entries = useAppState((s) => timeline(s.chat));
  const live = useAppState((s) => runningSlots(s.chat));
  const hasOlder = useAppState((s) => s.chat.nextCursor !== null);
  const runEvents = useAppState((s) => s.runEvents);
  const actions = useActions();
  const { name, nameWithTitle, color } = useNames();
  const now = useNow();
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const breaks = timeBreaks(entries.map((e) => e.message.createdAt));
  const windowLines = useAppState((s) => windowLinesAfter(s.notes.windowList[conv.id]));
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
        {entries.map((e, i) => (
          <Fragment key={e.message.id}>
            {breaks.has(i) && (
              <li className="chat-time">
                <time dateTime={e.message.createdAt}>{shortTime(e.message.createdAt, now)}</time>
              </li>
            )}
            <Entry entry={e} now={now} conv={conv} />
            {windowLines.get(e.message.id)?.map((w) => (
              <li key={w.id} className="chat-system chat-window-line">
                {name(w.agent)} 换了新窗口（第 {w.index} 个），之前的消息不再发给 {name(w.agent)}
                {" · "}
                <button
                  type="button"
                  className="button-link"
                  onClick={() => actions.notes.openNote({ kind: "conversation", conversationId: conv.id }, w.agent, conv.members, { noteId: w.handoffNoteId })}
                >
                  看交接笔记
                </button>
              </li>
            ))}
          </Fragment>
        ))}
        {live.map((sl, i) => {
          const text = partialReplyText(liveText[i] ?? "");
          return (
            <li key={sl.id} className="chat-row" data-side="agent">
              <Avatar label={name(sl.agent)} color={color(sl.agent)} />
              <div className="chat-bubble-wrap" style={agentStyle(color(sl.agent))}>
                <div className="chat-meta">
                  <b>{nameWithTitle(sl.agent)}</b> · 回答中
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
  const { name, nameWithTitle, color } = useNames();
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
    // C-33b 收一收：「没用到记忆」不挂在每条上了，详情里照样能看
    const badge = am.memoryEntriesUsed ? memoryBadge(am) : null;
    return (
      <li className="chat-row" data-side="agent" data-excluded={entry.excluded || undefined}>
        {check}
        <Avatar label={name(am.agent)} color={color(am.agent)} />
        <div className="chat-bubble-wrap" style={agentStyle(color(am.agent))}>
          <div className="chat-meta">
            <b>{nameWithTitle(am.agent)}</b>
          </div>
          {entry.replyTo && <QuoteLine message={entry.replyTo} prefix="回复" />}
          <MessageMenu message={am} now={now}>
            <div className="chat-bubble">
              <ReplyBody text={am.text} />
            </div>
          </MessageMenu>
          {badge && (
            <button
              type="button"
              className="chat-memory"
              title="这次回答用到的记忆来源"
              onClick={() => actions.chat.openSheet({ kind: "message", messageId: am.id })}
            >
              用到 {am.memoryEntriesUsed} 条记忆 · 查看
            </button>
          )}
          {!entry.excluded && <AgentMedia message={am} conv={conv} />}
          <NoteLine conv={conv} agent={am.agent} runId={am.runId} />
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
        {quoted && <QuoteLine message={quoted} prefix="引用" />}
        <MessageMenu message={um} now={now}>
          <UserContent message={um} />
        </MessageMenu>
        {(entry.reedited || um.replyAsVoice) && (
          <p className="chat-note chat-user-note">
            {[entry.reedited && "已重新编辑", um.replyAsVoice && "回答会用语音发"].filter(Boolean).join(" · ")}
          </p>
        )}
        <ImagesSeenLine message={um} slots={entry.slots} />
        {um.state !== "retracted" && <UserDraws message={um} conv={conv} />}
        <SlotLine slots={entry.slots} />
      </div>
      <UserAvatar />
    </li>
  );
}

/**
 * 回答下面那一行（ADR-005 §3）：这次回答里带了 room-note → 「C酱 更新了笔记 · 看改了什么」；
 * 删了一半以上 → 「这次删了不少笔记，看看对不对」；格式不对没存上 → 「笔记没存上」
 */
function NoteLine({ conv, agent, runId }: { conv: Conversation; agent: string; runId: string }) {
  const scope = { kind: "conversation" as const, conversationId: conv.id };
  const note = useAppState((s) => notesBySource(s.notes.history, scope).get(runId));
  const rejected = useAppState((s) => rejectedBySource(s.notes.rejected, scope).get(runId));
  const actions = useActions();
  const { name } = useNames();
  if (note) {
    return (
      <button
        type="button"
        className="chat-note-line"
        data-warn={note.shrankALot || undefined}
        onClick={() => actions.notes.openNote(scope, agent, conv.members, { noteId: note.id, tab: "diff" })}
      >
        {noteTimelineText(note, name(agent))} · 看改了什么
      </button>
    );
  }
  if (rejected) return <p className="chat-note">笔记没存上：{REJECT_LABEL[rejected.reason]}（回答照常）</p>;
  return null;
}

/** 你的头像：草案里在你的气泡右边，名字的第一个字（appearance.userDisplayName；读不到写「我」） */
function UserAvatar() {
  const label = useAppState((s) => s.appearance?.userDisplayName ?? "我");
  return (
    <span className="avatar avatar-me" aria-hidden="true">
      {[...label][0]}
    </span>
  );
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
  // 草案「长按消息」：一排图标 + 字。转发先不做（江浩 2026-11-02）
  const item = (icon: IconName, label: string, run: () => void, disabled = false) => (
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
      <Icon name={icon} size={20} />
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
          {item("copy", "复制", () => void navigator.clipboard?.writeText(messageText(message)))}
          {item("quote", "引用", () => actions.chat.quote(message.id), !usable)}
          {item("select", "多选", () => actions.chat.startSelect(message.id), !usable)}
          {item("topic", "转议题", () => actions.chat.startSelect(message.id), !usable)}
          {item("draw", "画一张", () => actions.chat.media.openDrawCard(message.id, stripCharts(messageText(message)).slice(0, 1000)), !usable)}
          {canRetract(message, now) && item("undo", "撤回", () => void actions.chat.retract(message.id))}
          {item("info", "详情", () => actions.chat.openSheet({ kind: "message", messageId: message.id }))}
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
  const { name, color } = useNames();
  const [picker, setPicker] = useState(false);
  const [stickers, setStickers] = useState(false);
  const [more, setMore] = useState(false);
  /** ＋ 面板里正在录音：这时不收起面板（收起会把这段录音静默丢掉，汐 #174） */
  const [recording, setRecording] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
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
    if (!recording) setMore(false);
    void actions.chat.send();
  };

  /** 在 @ 名单里点了一项：把刚打的「@」补成「@名字 」。点名就从正文认，所以补上字就算点了 */
  const pick = (who: "all" | string) => {
    const el = input.current;
    const label = who === "all" ? "所有人" : name(who);
    const pos = el?.selectionStart ?? draft.text.length;
    const before = draft.text.slice(0, pos);
    const text = before.endsWith("@") ? `${before}${label} ${draft.text.slice(pos)}` : `${before}@${label} ${draft.text.slice(pos)}`;
    actions.chat.setDraftText(text);
    actions.chat.setMentions(mentionsFromText(text, conv.members, name));
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

  const fileDisabled = !!draft.voice || importing || tooManyFiles;
  const recordDisabled = !!draft.voice || importing || draft.attachments.length > 0;
  const hasText = draft.text.trim().length > 0 || draft.attachments.length > 0 || !!draft.voice;

  /*
   * 草案的输入区：
   * - 桌面：一条圆角输入条 ——「＋」「表情」｜输入框｜黑色圆形发送
   * - 手机：「语音 / 键盘」切换｜输入框（或「按住 说话」）｜表情｜「＋」（有字时变成「发送」）
   * 「＋」里放图片、文件、录音和「回答用语音发」。
   */
  return (
    <form className="chat-composer" onSubmit={send} data-has-content={hasText || undefined} data-voice-mode={voiceMode || undefined}>
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
      <AttachmentTray conv={conv} />
      <VoiceDraft />
      {stickers && <StickerPanel onClose={() => setStickers(false)} />}
      {more && (
        <div className="chat-more" role="menu" aria-label="更多">
          <button type="button" role="menuitem" disabled={fileDisabled} onClick={() => (setMore(false), void actions.chat.media.pickAttachment("image"))}>
            <Icon name="image" size={26} />
            图片
          </button>
          <button type="button" role="menuitem" disabled={fileDisabled} onClick={() => (setMore(false), void actions.chat.media.pickAttachment("file"))}>
            <Icon name="folder" size={26} />
            文件
          </button>
          <RecordButton key={conv.id} disabled={recordDisabled} variant="tile" onRecordingChange={setRecording} />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={draft.replyAsVoice}
            title="打开后，这条消息的回答都会用语音发（在主控机本地合成）。你在话里说「用语音回我」也会自动打开"
            onClick={() => actions.chat.media.setReplyAsVoice(!draft.replyAsVoice)}
          >
            <Icon name="voice" size={26} />
            {draft.replyAsVoice ? "语音回 · 开" : "用语音回"}
          </button>
        </div>
      )}
      <div className="chat-compose-main">
        <button
          type="button"
          className="icon-tool tool-voice-mode"
          aria-label={voiceMode ? "切换到键盘" : "切换到语音"}
          onClick={() => setVoiceMode((v) => !v)}
        >
          <Icon name={voiceMode ? "keyboard" : "voice"} />
        </button>
        <button
          type="button"
          className="icon-tool tool-more"
          aria-expanded={more}
          aria-label="发送图片、文件"
          title={recording ? "正在录音：先在面板里点「停」" : "图片、文件、录音"}
          disabled={more && recording}
          onClick={() => setMore((v) => !v)}
        >
          <Icon name="plus" />
        </button>
        <button type="button" className="icon-tool tool-emoji" aria-expanded={stickers} aria-label="表情" title="表情" onClick={() => setStickers((v) => !v)}>
          <Icon name="emoji" />
        </button>
        {voiceMode && !draft.voice && (
          <RecordButton key={`hold-${conv.id}`} disabled={recordDisabled} variant="hold" />
        )}
        <div className="chat-input-row" hidden={!!draft.voice || voiceMode}>
          <textarea
            ref={input}
            rows={1}
            value={draft.text}
            placeholder={isGroup ? "说点什么…输入 @ 可以点名" : "说点什么…"}
            aria-label="消息"
            onChange={(e) => {
              const text = e.target.value;
              const pos = e.target.selectionStart ?? text.length;
              actions.chat.setDraftText(text);
              // 点名直接从正文认（打字 @ 就行，不用另外选）
              if (isGroup) actions.chat.setMentions(mentionsFromText(text, conv.members, name));
              // 刚打了一个 @ 就弹出成员名单，点一下帮你补上名字
              if (isGroup && text.length > draft.text.length && text[pos - 1] === "@") setPicker(true);
            }}
            onKeyDown={onKey}
          />
          {picker && isGroup && (
            <div className="chat-picker" role="listbox" aria-label="点名谁必须回答">
              <button type="button" role="option" aria-selected={draft.mentions.kind === "all"} onClick={() => pick("all")}>
                <span className="avatar avatar-sm avatar-all" aria-hidden="true">全</span>
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
                  <span className="avatar avatar-sm" style={{ background: color(a) }} aria-hidden="true">
                    {[...name(a)][0]}
                  </span>
                  {name(a)}
                </button>
              ))}
              {/* 鼠标用户点开名单又不想点名：关掉就行，打的 @ 留在正文里（汐 #174） */}
              <button type="button" className="chat-picker-close" onClick={() => (setPicker(false), input.current?.focus())}>
                不点名
              </button>
            </div>
          )}
        </div>
        <button type="submit" className="chat-send" aria-label="发送" disabled={!canSend}>
          <Icon name="send" size={20} />
          <span className="chat-send-label">发送</span>
        </button>
      </div>
      {tooLong && (
        <p className="chat-hint">
          <span className="field-error">太长了：最多 {CHAT_LIMITS.textMaxChars} 字</span>
        </p>
      )}
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
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const value = touched ? name : firstText;
  const tooMany = count > CHAT_LIMITS.toTopicMaxMessages;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!count || !value.trim() || tooMany) return;
    void actions.chat.toTopic(value.trim());
  };
  // 草案：底部一条「取消 · 已选 N 条 · → 转成议题」；起名放到点了「转成议题」之后
  return (
    <>
      <div className="chat-selectbar">
        <button type="button" className="button-pill" onClick={actions.chat.cancelSelect}>
          取消
        </button>
        <span className="chat-selectbar-count">
          已选 {count} 条{tooMany && <span className="field-error">（最多 {CHAT_LIMITS.toTopicMaxMessages} 条）</span>}
        </span>
        <button type="button" className="button-primary chat-selectbar-go" disabled={!count || tooMany} onClick={() => setNaming(true)}>
          <Icon name="arrow" size={16} />
          转成议题
        </button>
      </div>
      {naming && (
        <Sheet title="转成议题" onClose={() => setNaming(false)}>
          <form className="chat-sheet-body" onSubmit={submit}>
            <label className="chat-field">
              议题名称
              <input
                value={value}
                maxLength={200}
                autoFocus
                onChange={(e) => {
                  setTouched(true);
                  setName(e.target.value);
                }}
              />
            </label>
            <p className="chat-note">这 {count} 条消息会作为议题的材料。创建议题不会发给任何人，之后照讨论室流程先看内容、再盖章。</p>
            <button type="submit" className="button-primary" disabled={!value.trim() || tooMany}>
              创建议题
            </button>
          </form>
        </Sheet>
      )}
    </>
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
        <WindowsSection conv={conv} />
        <ImmersiveSection />
        <button type="button" className="button-outline" onClick={() => actions.chat.startSelect()}>
          多选消息，转成议题
        </button>
      </div>
    </Sheet>
  );
}

/**
 * 会话设置里的「换窗口」（ADR-005 §4）：每位一行「第 N 个窗口 · 这个窗口压缩 M 次」+「换窗口」。
 * 换的是秘书那边的对话（以后只从交接笔记接着聊），不是界面上的窗口；群聊每人分开换
 */
function WindowsSection({ conv }: { conv: Conversation }) {
  const windows = useAppState((s) => (s.notes.windowsAvailable ? s.notes.windows[conv.id] : undefined));
  const available = useAppState((s) => s.notes.windowsAvailable);
  const latest = useAppState((s) => s.notes.latest[`c:${conv.id}`]);
  const actions = useActions();
  const { name, color } = useNames();
  if (!available) return null;
  const scope = { kind: "conversation" as const, conversationId: conv.id };
  return (
    <fieldset className="chat-windows">
      <legend>换窗口（聊久了、压缩几次以后，让秘书从一份交接笔记重新开始）</legend>
      {!windows && <p className="chat-note">正在读取…</p>}
      {windows?.map((w) => {
        const note = latest?.find((n) => n.agent === w.agent);
        return (
          <div key={w.agent} className="chat-window-row" style={agentStyle(color(w.agent))}>
            <Avatar label={name(w.agent)} color={color(w.agent)} />
            <div className="chat-window-info">
              <b>{name(w.agent)}</b>
              <span className="chat-note" data-warn={w.suggestSwitch || undefined}>
                第 {w.index} 个窗口 · {compactionText(w)}
              </span>
              <button type="button" className="button-link" onClick={() => actions.notes.openNote(scope, w.agent, conv.members)}>
                笔记{note ? ` v${note.version}` : "（还没有）"}
              </button>
            </div>
            <div className="chat-window-actions">
              <button type="button" className="button-outline" onClick={() => void actions.notes.prepareWindow(conv.id, w.agent)}>
                {w.pendingDraft ? "看交接笔记" : "换窗口"}
              </button>
              {!w.pendingDraft && (
                <button type="button" className="button-link" onClick={() => void actions.notes.prepareWindow(conv.id, w.agent, true)}>
                  我自己写交接
                </button>
              )}
            </div>
          </div>
        );
      })}
      <p className="chat-note">先由秘书写一份交接笔记，你看过、可以改，点「换」才生效。换了以后，之前的消息不再发给他。不会自动换。</p>
    </fieldset>
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
