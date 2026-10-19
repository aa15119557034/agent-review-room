import { useMemo, useRef, useState, type FormEvent } from "react";
import { ContributionType, type Contribution, type Message, type TextSelection } from "@room/schemas";
import { segmentText, suggestTitle, trimSelection } from "../lib/selection";
import { selectionWithin } from "./dom-selection";
import { useActions, useAppState } from "./hooks";
import { CONTRIBUTION_TYPE_LABEL, formatTime } from "./labels";

const KNOWN_AGENTS = ["deepseek", "codex", "claude", "human"];
const AGENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 第 1 步：粘贴原文，在原文里选中一段标记成片段 */
export function SourceStep() {
  const messages = useAppState((s) => s.messages);
  const contributions = useAppState((s) => s.contributions);
  const sources = messages.filter((m) => m.kind === "source_input");

  return (
    <>
      <AddSourceForm hasSources={sources.length > 0} />
      {sources.length > 0 && (
        <ul className="source-list">
          {sources.map((m) => (
            <SourceItem key={m.id} message={m} contributions={contributions.filter((c) => c.sourceMessageId === m.id)} />
          ))}
        </ul>
      )}
    </>
  );
}

/** 还没有原文时直接展开；已有原文时收起成一个按钮，避免空的大输入框一直占着顶部 */
function AddSourceForm({ hasSources }: { hasSources: boolean }) {
  const [open, setOpen] = useState(false);
  if (hasSources && !open) {
    return (
      <button type="button" className="add-source-toggle" onClick={() => setOpen(true)}>
        再粘贴一段原文
      </button>
    );
  }
  return <AddSourceFields autoFocus={hasSources} onAdded={() => setOpen(false)} onCancel={hasSources ? () => setOpen(false) : undefined} />;
}

function AddSourceFields(props: { autoFocus: boolean; onAdded: () => void; onCancel?: () => void }) {
  const actions = useActions();
  const [agent, setAgent] = useState("deepseek");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const agentOk = AGENT_PATTERN.test(agent);
  const canSubmit = agentOk && content.trim().length > 0 && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    // 原样保存，不 trim、不改换行——片段下标要和原文对上
    const added = await actions.addSource(agent, content);
    setBusy(false);
    if (added) {
      setContent("");
      props.onAdded();
    }
  };

  return (
    <form className="add-source" onSubmit={submit}>
      <label className="field-label" htmlFor="source-content">
        粘贴 Agent 的输出
      </label>
      <textarea
        id="source-content"
        className="source-input"
        value={content}
        rows={5}
        maxLength={2_000_000}
        placeholder="把对话、方案、日志或代码原样粘贴进来"
        onChange={(e) => setContent(e.target.value)}
        autoFocus={props.autoFocus}
      />
      <div className="add-source-row">
        <label className="field-inline">
          来自
          <input
            className="agent-input"
            list="known-agents"
            value={agent}
            aria-invalid={!agentOk}
            onChange={(e) => setAgent(e.target.value.trim().toLowerCase())}
          />
        </label>
        <datalist id="known-agents">
          {KNOWN_AGENTS.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
        {!agentOk && <span className="field-error">只能用小写字母、数字和连字符</span>}
        {props.onCancel && (
          <button type="button" className="button-quiet add-source-cancel" onClick={props.onCancel}>
            取消
          </button>
        )}
        <button type="submit" className="button-primary" disabled={!canSubmit}>
          {busy ? "添加中…" : "添加原文"}
        </button>
      </div>
    </form>
  );
}

function SourceItem({ message, contributions }: { message: Message; contributions: Contribution[] }) {
  const textRef = useRef<HTMLPreElement>(null);
  const [selection, setSelection] = useState<TextSelection | null>(null);

  const segments = useMemo(
    () =>
      segmentText(
        message.content,
        contributions.map((c) => ({ id: c.id, ...c.selection })),
      ),
    [message.content, contributions],
  );

  // 鼠标或键盘结束选择时记下下标。之后焦点移到表单、浏览器选区消失也不影响
  const capture = () => {
    if (!textRef.current) return;
    const raw = selectionWithin(textRef.current);
    if (!raw) return;
    const trimmed = trimSelection(message.content, raw);
    if (trimmed) setSelection(trimmed);
  };

  return (
    <li className="source">
      <div className="source-meta">
        <span className="source-agent">{message.kind === "source_input" ? message.sourceAgent : ""}</span>
        <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
        <span className="source-hint">选中一段文字，标记成片段</span>
      </div>
      <pre ref={textRef} className="source-text" onMouseUp={capture} onKeyUp={capture} tabIndex={0}>
        {segments.map((s) =>
          s.covers.length ? (
            <mark key={s.start} className="source-mark" data-depth={Math.min(s.covers.length, 3)}>
              {s.text}
            </mark>
          ) : (
            <span key={s.start}>{s.text}</span>
          ),
        )}
      </pre>
      {selection && (
        <FragmentComposer
          // 重新选了一段 → 组件重建，默认标题跟着更新
          key={`${selection.start}-${selection.end}`}
          message={message}
          selection={selection}
          onDone={() => {
            setSelection(null);
            window.getSelection()?.removeAllRanges();
          }}
        />
      )}
    </li>
  );
}

function FragmentComposer(props: { message: Message; selection: TextSelection; onDone: () => void }) {
  const { message, selection, onDone } = props;
  const actions = useActions();
  const excerpt = message.content.slice(selection.start, selection.end);
  const [type, setType] = useState<ContributionType>("risk");
  const [title, setTitle] = useState(() => suggestTitle(excerpt));
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    const created = await actions.createContribution({
      sourceMessageId: message.id,
      contributionType: type,
      title: title.trim(),
      selection,
    });
    setBusy(false);
    if (created) onDone();
  };

  return (
    <form className="composer" onSubmit={submit} aria-label="标记片段">
      <blockquote className="composer-excerpt">{excerpt}</blockquote>
      <div className="composer-row">
        <label className="field-inline">
          类型
          <select value={type} onChange={(e) => setType(e.target.value as ContributionType)}>
            {ContributionType.options.map((t) => (
              <option key={t} value={t}>
                {CONTRIBUTION_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="field-inline field-grow">
          标题
          <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </label>
      </div>
      <div className="composer-row">
        <button type="submit" className="button-primary" disabled={!title.trim() || busy}>
          {busy ? "添加中…" : "添加片段"}
        </button>
        <button type="button" className="button-quiet" onClick={onDone}>
          取消
        </button>
        <span className="composer-count">{Array.from(excerpt).length} 字</span>
      </div>
    </form>
  );
}
