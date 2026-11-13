import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { PROJECT_NOTE_LIMITS, type NoteScope, type ProjectNote } from "@room/schemas";
import {
  boundaryText,
  diffSummary,
  handoffFailureText,
  handoffPhase,
  noteDiff,
  noteKey,
  scopeKey,
  versionLabel,
  type NoteTab,
  type NotesSheet,
} from "../../lib/notes";
import { conversationTitle, previewText, shortTime } from "../../lib/chat";
import { agentColor, agentName } from "../../lib/discussion";
import { useActions, useAppState } from "../hooks";
import { useDialog } from "../dialog";

/**
 * 项目笔记和换窗口的弹出单（C-47）。从下面推上来（同秘书资料页的「模型和思考强度」），聊天、讨论室、秘书页共用。
 * 笔记是秘书写的，按不可信内容处理：只当纯文本显示，不渲染 Markdown、不跑链接。
 */
export function NotesSheetHost() {
  const sheet = useAppState((s) => s.notes.sheet);
  if (!sheet) return null;
  if (sheet.kind === "note") return <NoteSheet key={`${scopeKey(sheet.scope)}|${sheet.agent}|${sheet.noteId ?? ""}`} sheet={sheet} />;
  return <HandoffSheet key={sheet.draftId} sheet={sheet} />;
}

function BottomSheet({ label, onClose, head, children }: { label: string; onClose: () => void; head: ReactNode; children: ReactNode }) {
  // Esc 关闭、打开时焦点进来、关闭后焦点回到打开它的按钮
  const ref = useDialog<HTMLElement>(onClose);
  return (
    <div className="profile-sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section ref={ref} tabIndex={-1} className="profile-sheet note-sheet" role="dialog" aria-modal="true" aria-label={label}>
        <span className="profile-sheet-grip" aria-hidden="true" />
        <header>{head}</header>
        {children}
      </section>
    </div>
  );
}

function useScopeTitle(scope: NoteScope): string {
  const disc = useAppState((s) => s.disc);
  const project = useAppState((s) => (scope.kind === "topic" ? s.projects.find((p) => p.id === scope.projectId) : undefined));
  const conv = useAppState((s) => (scope.kind === "conversation" ? s.chat.list?.find((x) => x.conversation.id === scope.conversationId)?.conversation : undefined));
  if (scope.kind === "topic") return `议题《${project?.name ?? "…"}》`;
  return conv ? `会话《${conversationTitle(conv, (a) => agentName(disc, a))}》` : "这个会话";
}

// ---------------------------------------------------------------- 看 / 改笔记

function NoteSheet({ sheet }: { sheet: Extract<NonNullable<NotesSheet>, { kind: "note" }> }) {
  const { scope, agent, agents } = sheet;
  const disc = useAppState((s) => s.disc);
  const history = useAppState((s) => s.notes.history[noteKey(scope, agent)]);
  const listed = useAppState((s) => s.notes.latest[scopeKey(scope)]?.find((n) => n.agent === agent));
  const actions = useActions();
  const name = (a: string) => agentName(disc, a);
  const scopeTitle = useScopeTitle(scope);
  const [tab, setTab] = useState<NoteTab>(sheet.tab ?? "note");
  const [viewingId, setViewingId] = useState<string | null>(sheet.noteId ?? null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const latest = history?.[0] ?? listed;
  const viewing = (viewingId ? history?.find((n) => n.id === viewingId) : undefined) ?? (viewingId ? undefined : latest);
  const isLatest = viewing !== undefined && viewing.id === latest?.id;
  const versionOf = (id: string) => history?.find((n) => n.id === id)?.version;

  const close = actions.notes.closeSheet;
  const save = async () => {
    if (editing === null) return;
    setBusy(true);
    const ok = await actions.notes.editNote(scope, agent, editing, latest?.id ?? null);
    setBusy(false);
    if (ok) {
      setEditing(null);
      setViewingId(null);
      setTab("note");
    }
  };
  const revert = async (n: ProjectNote) => {
    setBusy(true);
    const ok = await actions.notes.revertNote(n);
    setBusy(false);
    if (ok) {
      setViewingId(null);
      setTab("note");
    }
  };

  const head =
    editing === null ? (
      <>
        <h2>{name(agent)} 的笔记</h2>
        <button type="button" className="button-link" onClick={close}>关闭</button>
      </>
    ) : (
      <>
        <h2>改 {name(agent)} 的笔记</h2>
        <button type="button" className="button-link" onClick={() => setEditing(null)}>取消</button>
        <button type="button" className="button-primary profile-done" disabled={busy} onClick={() => void save()}>
          {busy ? "保存中…" : "保存"}
        </button>
      </>
    );

  return (
    <BottomSheet label={`${name(agent)} 的笔记`} onClose={close} head={head}>
      {agents.length > 1 && editing === null && (
        <div className="note-people" role="tablist" aria-label="看谁的笔记">
          {agents.map((a) => (
            <button
              key={a}
              type="button"
              role="tab"
              aria-selected={a === agent}
              style={{ "--agent": agentColor(disc, a) } as CSSProperties}
              onClick={() => a !== agent && actions.notes.openNote(scope, a, agents)}
            >
              <span className="avatar" aria-hidden="true">{name(a).slice(0, 1)}</span>
              {name(a)}
            </button>
          ))}
        </div>
      )}
      <p className="side-note">
        {scopeTitle} · 发给 {name(agent)} 时只带他自己这份，别人的不带
      </p>

      {editing !== null ? (
        <>
          <textarea
            className="settings-input note-editor"
            rows={14}
            maxLength={PROJECT_NOTE_LIMITS.maxChars}
            value={editing}
            autoFocus
            onChange={(e) => setEditing(e.target.value)}
          />
          <p className="side-note">
            {editing.length.toLocaleString()} / {PROJECT_NOTE_LIMITS.maxChars.toLocaleString()} 字 · 存成新的一版，旧的还在、能回退。下次发给 {name(agent)} 时生效
          </p>
        </>
      ) : latest === undefined ? (
        <>
          <p className="note-empty">{name(agent)} 在这里还没有笔记。秘书会在回答里自己记；你也可以先写一份给他。</p>
          <button type="button" className="button-outline" onClick={() => setEditing("")}>写一份</button>
        </>
      ) : (
        <>
          <div className="summary-tabs" role="tablist" aria-label="笔记">
            <button type="button" role="tab" aria-selected={tab === "note"} onClick={() => setTab("note")}>笔记</button>
            <button type="button" role="tab" aria-selected={tab === "diff"} onClick={() => setTab("diff")}>改了什么</button>
            <button type="button" role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>
              历史版本 {history ? history.length : ""}
            </button>
          </div>

          {tab !== "history" && viewing && (
            <p className="note-meta">
              <b>第 {viewing.version} 版</b> · {versionLabel(viewing, name, versionOf)} · {shortTime(viewing.createdAt, Date.now())}
              {!isLatest && <span className="console-tag">不是最新版</span>}
            </p>
          )}
          {tab !== "history" && viewing?.shrankALot && (
            <p className="note-warn">这一版比上一版少了一半以上，看看是不是删多了。不对就回退到上一版。</p>
          )}

          {tab === "note" && viewing && <pre className="note-text">{viewing.content || "（空）"}</pre>}
          {tab === "diff" && viewing && <NoteDiff note={viewing} history={history} />}
          {tab === "history" && (
            <ul className="note-versions">
              {(history ?? [latest]).map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    aria-current={n.id === viewing?.id || undefined}
                    onClick={() => {
                      setViewingId(n.id === latest.id ? null : n.id);
                      setTab("note");
                    }}
                  >
                    <b>v{n.version}</b>
                    <span>{versionLabel(n, name, versionOf)}</span>
                    {n.shrankALot && <span className="console-tag">删了不少</span>}
                    <span className="side-note">{shortTime(n.createdAt, Date.now())}</span>
                  </button>
                </li>
              ))}
              {history && history.length >= 200 && <li className="side-note">更早的在导出和 GitHub 历史里。</li>}
            </ul>
          )}

          {tab !== "history" && viewing && (
            <div className="side-actions">
              {isLatest ? (
                <button type="button" className="button-outline" onClick={() => setEditing(viewing.content)}>改</button>
              ) : (
                <>
                  <button type="button" className="button-outline" disabled={busy} onClick={() => void revert(viewing)}>
                    回退到第 {viewing.version} 版
                  </button>
                  <button type="button" className="button-link" onClick={() => setViewingId(null)}>回到最新版</button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </BottomSheet>
  );
}

function NoteDiff({ note, history }: { note: ProjectNote; history: ProjectNote[] | undefined }) {
  const parent = note.parentId ? history?.find((n) => n.id === note.parentId) : undefined;
  if (note.parentId && !parent) return <p className="side-note">正在读上一版…</p>;
  const lines = noteDiff(parent?.content ?? "", note.content);
  return (
    <>
      <p className="side-note">{parent ? `和第 ${parent.version} 版比：${diffSummary(lines)}` : "这是第 1 版，全部是新写的。"}</p>
      <pre className="note-diff">
        {lines.map((l, i) => (
          <span key={i} data-kind={l.kind}>
            {l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}
            {l.text}
            {"\n"}
          </span>
        ))}
      </pre>
    </>
  );
}

// ---------------------------------------------------------------- 换窗口

/**
 * 换窗口（ADR-005 §4）：秘书先写一份交接笔记，你看、可以改，点「换」才生效。
 * 关掉这张单不会丢：草稿在 main 里，下次点「换窗口」或记忆条上的「交接笔记」接着看。
 */
function HandoffSheet({ sheet }: { sheet: Extract<NonNullable<NotesSheet>, { kind: "handoff" }> }) {
  const disc = useAppState((s) => s.disc);
  const draft = useAppState((s) => s.notes.drafts[sheet.draftId]);
  const run = useAppState((s) => (draft?.runId ? s.notes.handoffRuns[draft.runId] : undefined));
  const messages = useAppState((s) => (s.chat.currentId === sheet.conversationId ? s.chat.messages : []));
  const current = useAppState((s) => s.notes.latest[`c:${sheet.conversationId}`]?.find((n) => n.agent === sheet.agent));
  const group = useAppState((s) => s.chat.list?.find((x) => x.conversation.id === sheet.conversationId)?.conversation.kind === "group");
  const actions = useActions();
  const name = (a: string) => agentName(disc, a);
  const who = name(sheet.agent);
  /** 你在框里改过、还没存进草稿的文字；null = 没动过，显示草稿里的 */
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = actions.notes.closeSheet;

  if (!draft) {
    return (
      <BottomSheet label="换窗口" onClose={close} head={<><h2>换窗口</h2><button type="button" className="button-link" onClick={close}>关闭</button></>}>
        <p className="side-note">正在读取…</p>
      </BottomSheet>
    );
  }
  const phase = handoffPhase(draft, run);
  const shown = text ?? draft.content ?? "";
  const dirty = text !== null && text !== draft.content;
  const writeMyself = async () => {
    setBusy(true);
    // 「不等了，我自己写」：拿他现在的笔记当底子；这一下会停掉还在写的 Run
    const base = current?.content ?? "";
    const d = await actions.notes.editDraft(draft.id, base);
    if (d) setText(null);
    setBusy(false);
  };
  const run_ = async (f: () => Promise<unknown>) => {
    setBusy(true);
    await f();
    setBusy(false);
  };

  return (
    <BottomSheet
      label={`给 ${who} 换窗口`}
      onClose={close}
      head={
        <>
          <h2>给 {who} 换窗口</h2>
          <button type="button" className="button-link" onClick={close}>{phase === "closed" ? "关闭" : "先放着"}</button>
        </>
      }
    >
      <p className="note-boundary">
        新窗口从 {boundaryText(draft.startsAfterMessageId, messages, (m) => previewText(m, name))} 之后开始。
        换了以后，这条和之前的消息不再发给 {who}，只带下面这份交接笔记和之后的新消息。{group ? "群里其他人不受影响。" : ""}
      </p>

      {phase === "writing" && (
        <>
          <p className="note-writing" role="status">
            <span className="cursor" aria-hidden="true">▍</span> {who} 正在写交接笔记：做到哪了、要记住的约定、还没回答的事…
          </p>
          <div className="side-actions">
            <button type="button" className="button-outline" disabled={busy} onClick={() => void writeMyself()}>不等了，我自己写</button>
            <button type="button" className="button-link" disabled={busy} onClick={() => void run_(() => actions.notes.cancelWindow(draft.id))}>不换了</button>
          </div>
        </>
      )}

      {phase === "failed" && (
        <>
          <p className="note-warn">{handoffFailureText(run)} 可以让 {who} 重写，或者你自己写。</p>
          <div className="side-actions">
            <button type="button" className="button-outline" disabled={busy} onClick={() => void run_(() => actions.notes.redoDraft(draft.id))}>重写</button>
            <button type="button" className="button-outline" disabled={busy} onClick={() => void writeMyself()}>我自己写</button>
            <button type="button" className="button-link" disabled={busy} onClick={() => void run_(() => actions.notes.cancelWindow(draft.id))}>不换了</button>
          </div>
        </>
      )}

      {phase === "ready" && (
        <>
          <p className="note-meta">
            <b>交接笔记</b> · {draft.contentBy === "agent" && !dirty ? `${who} 写的` : "你写 / 改过的"} · 会存成 {who} 在这个会话的笔记新版
          </p>
          <textarea
            className="settings-input note-editor"
            rows={12}
            maxLength={PROJECT_NOTE_LIMITS.maxChars}
            value={shown}
            aria-label="交接笔记"
            placeholder={`写给新窗口里的 ${who}：做到哪了、要记住的约定、还没回答的事`}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="side-actions">
            <button
              type="button"
              className="button-primary"
              disabled={busy}
              onClick={() => void run_(() => actions.notes.confirmWindow(draft.id, dirty ? shown : null))}
            >
              {busy ? "正在换…" : "换"}
            </button>
            {dirty && (
              <button type="button" className="button-outline" disabled={busy} onClick={() => void run_(async () => (await actions.notes.editDraft(draft.id, shown)) && setText(null))}>
                先存修改
              </button>
            )}
            {draft.runId !== null || draft.contentBy === "agent" ? (
              <button type="button" className="button-outline" disabled={busy} onClick={() => void run_(async () => { setText(null); await actions.notes.redoDraft(draft.id); })}>
                让 {who} 重写
              </button>
            ) : null}
            <button type="button" className="button-link" disabled={busy} onClick={() => void run_(() => actions.notes.cancelWindow(draft.id))}>不换了</button>
          </div>
          <p className="side-note">点「换」之前随时可以关掉，交接笔记留着，下次接着看。</p>
        </>
      )}

      {phase === "closed" && <p className="side-note">{draft.state === "confirmed" ? `已经给 ${who} 换好了。` : "这次不换了，什么都没改。"}</p>}
    </BottomSheet>
  );
}
