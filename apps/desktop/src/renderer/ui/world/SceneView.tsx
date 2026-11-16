import { useEffect, useRef, useState, type FormEvent } from "react";
import type { WorldScene, WorldSceneLine, WorldSnapshot } from "@room/schemas";
import { actorName, dayClockText, placeKind, type WorldNames } from "../../lib/world";
import { useActions, useAppState } from "../hooks";
import { WorldSheet } from "./WorldSheet";

/**
 * 剧情和对话（ADR-008 §2 / C-56）：背景 + 在场居民的立绘 + 对话框 + 选项 + 打一句话。
 * 盖在小屋上面，不暂停世界。台词、选项、能不能打字都是后端给的；这里不执行台词里的任何东西，只当纯文本显示。
 */
export function SceneView({ scene, world, names }: { scene: WorldScene; world: WorldSnapshot; names: WorldNames }) {
  const actions = useActions();
  const [backlog, setBacklog] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // 对话是你主动打开的：把它带到眼前并把焦点放进来。窄窗口里小屋在上、居民面板在下，不滚上来就像点了没反应
  const root = useRef<HTMLElement | null>(null);
  useEffect(() => {
    root.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    root.current?.focus({ preventScroll: true });
  }, [scene.id]);
  const place = world.places.find((p) => p.id === scene.placeId);
  const waiting = scene.state === "waiting";
  // 暂停着：台词照样能看、能回看，选项和输入先不能用（按了也会被规则拒绝）
  const paused = world.run.state === "paused";

  const run = async (f: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await f();
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || waiting) return;
    void run(async () => {
      if (await actions.world.sceneSay(scene.id, t)) setText("");
    });
  };

  return (
    <section ref={root} tabIndex={-1} className="scene" data-kind={place ? placeKind(place) : "living"} aria-label={`和${scene.residents.map(names.agent).join("、")}的对话`}>
      <div className="scene-top">
        <span className="scene-place">{names.place(scene.placeId)}</span>
        <button type="button" className="scene-btn" aria-pressed={backlog} onClick={() => setBacklog((b) => !b)}>{backlog ? "回到对话" : "前面说了什么"}</button>
        <button type="button" className="scene-btn" disabled={busy} onClick={() => void run(() => actions.world.sceneClose(scene.id))}>结束对话</button>
      </div>

      {backlog ? (
        <div className="scene-backlog"><Transcript lines={scene.lines} names={names} /></div>
      ) : (
        <div className="scene-box" aria-live="polite">
          {scene.lines.length ? (
            <Transcript lines={scene.lines} names={names} />
          ) : (
            <p className="scene-text">…</p>
          )}
          {waiting && !paused && <p className="scene-waiting" role="status">她在想怎么回…</p>}
          {paused && <p className="scene-waiting" role="status">世界暂停着，按「继续」以后才能接着说。</p>}
        </div>
      )}

      {!backlog && (
        <div className="scene-controls">
          {scene.options.length > 0 && (
            <div className="scene-options">
              {scene.options.map((o) => (
                <button key={o.id} type="button" className="scene-option" disabled={busy || waiting || paused} onClick={() => void run(() => actions.world.sceneChoose(scene.id, o.id))}>
                  {o.label}
                </button>
              ))}
            </div>
          )}
          {scene.canType ? (
            <form className="scene-say" onSubmit={submit}>
              <input value={text} maxLength={500} placeholder="对她说一句…" aria-label="对她说一句" disabled={waiting || paused} onChange={(e) => setText(e.target.value)} />
              <button type="submit" className="button-primary" disabled={!text.trim() || waiting || busy || paused}>说</button>
            </form>
          ) : (
            <p className="scene-note">{scene.options.length > 0 ? "她现在没法回应你打的话，可以用上面的选项。" : "她现在没法回应你打的话。"}</p>
          )}
        </div>
      )}
    </section>
  );
}

function Transcript({ lines, names }: { lines: readonly WorldSceneLine[]; names: WorldNames }) {
  const end = useRef<HTMLLIElement | null>(null);
  const list = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    const scroll=()=>{const viewport=end.current?.closest(".scene-box,.scene-backlog");if(viewport)viewport.scrollTop=viewport.scrollHeight;else end.current?.scrollIntoView({block:"end"});};
    const frame=requestAnimationFrame(scroll);const resize=new ResizeObserver(scroll);if(list.current)resize.observe(list.current);
    return ()=>{cancelAnimationFrame(frame);resize.disconnect();};
  }, [lines.length]);
  return (
    <ol className="transcript" ref={list}>
      {lines.map((l, i) => (
        <li key={i} data-who={l.speaker === null ? "narration" : l.speaker.kind} ref={i === lines.length - 1 ? end : undefined}>
          <strong>{l.speaker ? actorName(l.speaker, names) : "旁白"}{l.source === "chat" ? <small className="scene-source">闲聊</small> : null}</strong>
          <span>{l.text}</span>
        </li>
      ))}
    </ol>
  );
}

/** 以前的对话：只重放显示，不改世界 */
export function PastScenes({ names }: { names: WorldNames }) {
  const past = useAppState((s) => s.world.pastScenes)!;
  const actions = useActions();
  return (
    <WorldSheet label="以前的对话" onClose={actions.world.closeScenes}>
      {past.items.length === 0 && <p className="resident-note" role="status">{past.loading ? "正在读…" : "还没有说过话。走到她在的屋子，点「找她说话」。"}</p>}
      {past.items.map((sc) => (
        <details key={sc.id} className="past-scene">
          <summary>
            {dayClockText(sc.openedAt)} · {names.place(sc.placeId)} · {sc.residents.map(names.agent).join("、")}
          </summary>
          <Transcript lines={sc.lines} names={names} />
          {sc.past.filter((p) => p.outcome === "chosen").map((p) => (
            <p key={p.option.id} className="past-choice">你选了：{p.option.label}</p>
          ))}
        </details>
      ))}
      {past.nextBefore !== null && (
        <button type="button" className="button-link" disabled={past.loading} onClick={() => void actions.world.showScenes(true)}>更早的</button>
      )}
    </WorldSheet>
  );
}
