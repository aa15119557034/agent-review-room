/**
 * 极简状态容器：不引入第三方状态库。
 * React 侧通过 useSyncExternalStore 订阅（见 ui/hooks.ts）。
 */
export interface Store<S> {
  get(): S;
  set(update: (prev: S) => S): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(update) {
      const next = update(state);
      if (next === state) return;
      state = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
