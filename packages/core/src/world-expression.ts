import {
  AgentName, WorldActivity, WorldAction, WorldEvent, WorldId, WorldMinutes, WorldResident,
  WorldResidentView, WorldSay, WORLD_MINUTES_PER_DAY,
  type WorldActor, type WorldActivityKind, type WorldPlace, type WorldSceneLine,
} from "@room/schemas";

export interface WorldSayInput {
  readonly worldId: WorldId;
  readonly agent: WorldResident["agent"];
  readonly now: number;
  readonly resident: WorldResident;
  readonly view: WorldResidentView;
  /** Complete store.observedEvents(worldId, agent), never the global timeline. */
  readonly observedEvents: { readonly worldId: WorldId; readonly agent: WorldResident["agent"]; readonly events: readonly WorldEvent[] };
  readonly activity: WorldActivity | null;
  readonly places: readonly Pick<WorldPlace, "id" | "label">[];
  readonly agentNames: Readonly<Record<string, string>>;
  readonly propose: WorldAction | null;
}

const activities: Record<WorldActivityKind, string> = {
  cook: "做饭", eat: "吃饭", read: "看书", rest: "休息", sleep: "睡觉", tidy: "收拾屋子", set_table: "摆餐桌",
};
const items: Readonly<Record<string, string>> = { book: "书", pot: "锅", seat: "座位", ingredients: "食材", meals: "饭" };
const sameActor = (a: WorldActor, b: WorldActor) => a.kind === b.kind && (a.kind === "player" || (b.kind === "resident" && a.agent === b.agent));
const timeText = (at: number) => `第${Math.floor(at / WORLD_MINUTES_PER_DAY) + 1}天${String(Math.floor(at % WORLD_MINUTES_PER_DAY / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`;

/** A deterministic expression from the resident's own evidence. No global snapshot or commitments enter this function. */
export function renderWorldSay(say: WorldSay, input: WorldSayInput): Pick<WorldSceneLine, "text" | "expression"> | null {
  const worldId = WorldId.parse(input.worldId), agent = AgentName.parse(input.agent), now = WorldMinutes.parse(input.now);
  const resident = WorldResident.parse(input.resident), view = WorldResidentView.parse(input.view);
  if (resident.agent !== agent || view.agent !== agent || view.worldId !== worldId ||
      input.observedEvents.worldId !== worldId || input.observedEvents.agent !== agent) {
    throw new Error("world expression evidence does not belong to the bound world and resident");
  }
  const activity = input.activity === null ? null : WorldActivity.parse(input.activity);
  if (resident.activityId !== (activity?.id ?? null) || (activity !== null &&
      (activity.state !== "running" || activity.placeId !== resident.placeId || activity.startedAt > now ||
       !activity.participants.some((actor) => actor.kind === "resident" && actor.agent === agent)))) {
    throw new Error("world expression activity does not belong to this resident");
  }
  const events = new Map<number, WorldEvent>();
  for (const raw of [...input.observedEvents.events, ...view.seen]) {
    const event = WorldEvent.parse(raw);
    if (event.at > now) throw new Error("world expression contains future observations");
    const previous = events.get(event.seq);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw new Error("conflicting world expression references");
    events.set(event.seq, event);
  }
  if (view.knownItems.some((item) => item.asOf > now) || view.heard.some((heard) => heard.at > now)) throw new Error("world expression contains future knowledge");
  const heard = new Map<number, WorldResidentView["heard"][number]>();
  for (const entry of [...view.heard, ...[...events.values()].flatMap((event) => event.type === "said" ? [{ seq: event.seq, at: event.at, speaker: event.speaker, text: event.text }] : [])]) {
    const previous = heard.get(entry.seq), event = events.get(entry.seq);
    if ((event && event.type !== "said") || (previous && JSON.stringify(previous) !== JSON.stringify(entry))) throw new Error("conflicting heard expression references");
    heard.set(entry.seq, entry);
  }
  const witnessed = [...events.values()].filter((event) => event.type !== "said").sort((a, b) => a.seq - b.seq);
  const actorName = (actor: WorldActor): string | null => actor.kind === "player" ? "你" : actor.agent === agent ? "我" : input.agentNames[actor.agent] || null;
  const placeName = (place: string) => input.places.find((entry) => entry.id === place)?.label ?? null;
  const itemName = (id: string) => view.knownItems.some((item) => item.itemId === id) ? items[id] ?? null : null;

  // Establish the parties from a witnessed invitation. A later observed end is
  // linked only through a witnessed start, never by consulting live commitments.
  const ownCommitment = (id: string) => {
    const invite = witnessed.find((event) => event.type === "action" && event.action.type === "invite" && event.commitmentId === id);
    if (!invite || invite.type !== "action" || invite.action.type !== "invite") return null;
    const by = invite.action.to, to = invite.actor;
    if (![by, to].some((actor) => actor.kind === "resident" && actor.agent === agent)) return null;
    let latest: WorldEvent = invite;
    const linked = new Set<string>();
    for (const event of witnessed) {
      if (event.seq <= invite.seq) continue;
      if (event.type === "action" && event.commitmentId === id) {
        if (event.action.type === "answer" && event.action.commitmentId === id && sameActor(event.actor, by)) latest = event;
        if (event.action.type === "cancel" && event.action.commitmentId === id && [by, to].some((party) => sameActor(party, event.actor))) latest = event;
        if (event.action.type === "start" && event.activityId !== null && sameActor(event.actor, by) && event.action.activity === invite.action.activity) {
          linked.add(event.activityId); latest = event;
        }
      } else if (event.type === "activity_ended" && linked.has(event.activity.id)) latest = event;
    }
    return { by, to, kind: invite.action.activity, latest };
  };

  const heardText = (entry: WorldResidentView["heard"][number]): string | null => {
    const speaker = actorName(entry.speaker);
    if (speaker === null) return null;
    const prefix = `我记得${speaker === "我" ? "自己" : speaker}说过：`;
    const suffix = "。这是当时听到的话。";
    const quoted = JSON.stringify(entry.text);
    if ((prefix + quoted + suffix).length <= 497) return prefix + quoted + suffix;
    // Quote a literal prefix, with an explicit truncation notice outside the
    // quotation. JSON escaping prevents embedded quote/newline delimiters from
    // turning part of the original speech into our own asserted sentence.
    const chars = Array.from(entry.text);
    let low = 0, high = chars.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((prefix + JSON.stringify(chars.slice(0, middle).join("")) + "（引文已截断）" + suffix).length <= 497) low = middle;
      else high = middle - 1;
    }
    return low === 0 ? null : prefix + JSON.stringify(chars.slice(0, low).join("")) + "（引文已截断）" + suffix;
  };

  const recall = (event: WorldEvent): string | null => {
    if (event.type === "said") return heardText(event);
    if (event.type === "clock") return `我记得，第${event.day}天${event.mark === "day_started" ? "开始" : "结束"}了。`;
    // Legacy views could contain UI scene history. It is not a witnessed
    // physical experience and must not be promoted into personal recollection.
    if (event.type === "scene") return null;
    if (event.type === "activity_ended") return `我记得，那次${activities[event.activity.kind]}${event.activity.state === "completed" ? "完成了" : "没有做完就结束了"}。`;
    const who = actorName(event.actor), act = event.action;
    if (who === null) return null;
    switch (act.type) {
      case "move": { const place = placeName(act.to); return place ? `我记得，${who}去了${place}。` : null; }
      case "take": case "put": { const item = items[act.itemId]; return item ? `我记得，${who}${act.type === "take" ? "拿起" : "放下"}了${item}。` : null; }
      case "start": return `我记得，${who}开始${activities[act.activity]}了。`;
      case "join": return `我记得，${who}加入了那次活动。`;
      case "stop": return `我记得，${who}停下了手上的活动。`;
      case "invite": { const whom = actorName(act.to); return whom ? `我记得，${who}邀请${whom}一起${activities[act.activity]}。` : null; }
      case "answer": return `我记得，${who}${act.answer === "accept" ? "答应了那次邀约" : act.answer === "decline" ? "婉拒了那次邀约" : `说想改到${timeText(act.dueAt!)}再做`}。`;
      case "cancel": return `我记得，${who}取消了那次约定。`;
    }
  };

  const intend = (action: WorldAction): string | null => {
    switch (action.type) {
      case "move": { const place = placeName(action.to); return place ? `我想去${place}。` : null; }
      case "take": case "put": { const item = itemName(action.itemId); return item ? `我想${action.type === "take" ? "拿起" : "放下"}${item}。` : null; }
      case "start": return `我想先${activities[action.activity]}。`;
      case "stop": return "我想先停一停。";
      case "invite": { const whom = actorName(action.to); return whom ? `我想邀${whom}一起${activities[action.activity]}。` : null; }
      case "join": return witnessed.some((event) => event.type === "action" && event.action.type === "start" && event.activityId === action.activityId) ? "我想加入那次活动。" : null;
      case "answer": case "cancel": {
        if (ownCommitment(action.commitmentId) === null) return null;
        if (action.type === "cancel") return "我想取消这次约定。";
        return action.answer === "accept" ? "我想答应这次邀约。" : action.answer === "decline" ? "我想婉拒这次邀约。" : `我想改到${timeText(action.dueAt!)}再做。`;
      }
    }
  };

  const parsed = WorldSay.safeParse(say);
  if (!parsed.success) return null;
  const chosen = parsed.data, intent = chosen.intent;
  let text: string | null = null;
  switch (intent.kind) {
    // Unverified chat is persisted separately by main, never rendered as fact.
    case "chat": return null;
    case "greet": text = { plain: "你好。", warm: "你好呀。", playful: "嘿，你好呀。", soft: "你好，慢慢聊。", curt: "你好。" }[chosen.tone]; break;
    case "respond": text = { agree: "这个想法我挺认同的。", decline: "这个想法我暂时不太赞同。", thanks: "谢谢你。", sorry: "抱歉。", comfort: "慢慢来，先缓一缓。", glad: "听你这么说，我很高兴。", unsure: "这个我还拿不准。" }[intent.feeling]; break;
    case "intend": { const proposed = WorldAction.safeParse(input.propose); text = proposed.success ? intend(proposed.data) : null; break; }
    case "own_state": {
      const value = resident[intent.gauge];
      text = intent.gauge === "energy" ? value < 30 ? "我有些累了。" : value < 65 ? "我有一点疲惫。" : "我现在精神还不错。" :
        intent.gauge === "satiety" ? value < 30 ? "我饿了。" : value < 65 ? "我有点饿。" : "我现在还不饿。" :
          value < 30 ? "我的心情有些低落。" : value < 65 ? "我现在心情还算平静。" : "我现在心情不错。";
      break;
    }
    case "activity": if (activity) text = `我正在${activities[activity.kind]}，${activity.endsAt > now ? `预计还要${activity.endsAt - now}分钟` : "还在等这件事结束"}。`; break;
    case "item": {
      const known = view.knownItems.find((item) => item.itemId === intent.itemId), item = items[intent.itemId];
      if (!item) break;
      if (!known) { text = `我不清楚${item}在哪里。`; break; }
      if (known.at === null) { text = `${item}现在在哪儿，我说不准。`; break; }
      const where = known.at.kind === "place" ? placeName(known.at.placeId) : actorName(known.at.by);
      if (where) text = `我上次看到${item}在${known.at.kind === "held" ? (where === "我" ? "自己" : where) + "手里" : where}。`;
      break;
    }
    case "recall": { const quote = heard.get(intent.seq), event = events.get(intent.seq); text = quote ? heardText(quote) : event ? recall(event) : null; break; }
    case "commitment": {
      const known = ownCommitment(intent.commitmentId);
      if (known) {
        // Every form describes the last witnessed step, not the unobserved
        // current status (including time-based expiry or a remote cancellation).
        const last = recall(known.latest);
        if (last) text = `说起那次${activities[known.kind]}的约定，${last}`;
      }
      break;
    }
  }
  if (text === null) return null;
  if (intent.kind !== "greet" && chosen.tone !== "plain" && chosen.tone !== "curt") text = (chosen.tone === "playful" ? "嗯哼，" : "嗯，") + text;
  return text.length <= 500 ? { text, expression: chosen.expression } : null;
}
