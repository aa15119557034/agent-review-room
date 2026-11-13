import type { ReactNode } from "react";
import { setupHint } from "../lib/discussion";
import { useActions, useAppState } from "./hooks";
import { Icon, type IconName } from "./Icon";

/**
 * 空状态：居中的线条图标 + 一句标题 + 一句说明 + 一个主要操作。
 * 聊天、秘书、讨论室三个页面共用，样式在 polish.css（.empty-state）。
 */
export function EmptyState(props: { icon: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <section className="empty-state">
      <span className="empty-state-icon" aria-hidden="true">
        <Icon name={props.icon} size={30} />
      </span>
      <h2 className="empty-state-title">{props.title}</h2>
      {props.children && <div className="empty-state-text">{props.children}</div>}
      {props.action && <div className="empty-state-actions">{props.action}</div>}
    </section>
  );
}

/** 数据还在读：不显示引导也不显示「还没有…」，免得闪一下 */
export function LoadingState() {
  return (
    <p className="empty-state empty-state-loading" role="status">
      正在读取…
    </p>
  );
}

/**
 * 现在该不该显示「开始使用」：
 * - "loading"：秘书名单还没读完
 * - "no_agents"：一位秘书都没有（第一次打开）
 * - "no_node"：有秘书，但没有一位连了节点
 * - null：可以正常用了
 */
export function useSetup(): "loading" | "no_agents" | "no_node" | null {
  return useAppState((s) => (s.disc.available && !s.disc.agentsLoaded ? "loading" : setupHint(s.disc)));
}

/** 「开始使用」三步引导：还没有秘书（或秘书都没连节点）时，三个页面显示同一个 */
export function GettingStarted({ reason }: { reason: "no_agents" | "no_node" }) {
  const actions = useActions();
  return (
    <section className="empty-state getting-started" aria-labelledby="getting-started-title">
      <span className="empty-state-icon" aria-hidden="true">
        <Icon name="sparkle" size={30} />
      </span>
      <h2 className="empty-state-title" id="getting-started-title">
        {reason === "no_agents" ? "开始使用" : "秘书还没连上节点"}
      </h2>
      <p className="empty-state-text">
        {reason === "no_agents"
          ? "三步把你的秘书请进来，之后就能聊天和开讨论了。"
          : "秘书已经添加，但还没有连到任何一台电脑。按下面三步检查一下。"}
      </p>
      <ol className="getting-started-steps">
        <li>
          <span className="getting-started-num" aria-hidden="true">1</span>
          <span>
            <b>连接节点</b>
            在「设置 › 连接」填上节点的地址和 Token
          </span>
        </li>
        <li>
          <span className="getting-started-num" aria-hidden="true">2</span>
          <span>
            <b>请秘书进来</b>
            在「设置 › 秘书接入」点「填入推荐的三位秘书」
          </span>
        </li>
        <li>
          <span className="getting-started-num" aria-hidden="true">3</span>
          <span>
            <b>开始</b>
            回到这里，新建一个会话或议题
          </span>
        </li>
      </ol>
      <div className="empty-state-actions">
        <button type="button" className="button-primary" onClick={() => void actions.openSettings()}>
          去设置
        </button>
      </div>
    </section>
  );
}
