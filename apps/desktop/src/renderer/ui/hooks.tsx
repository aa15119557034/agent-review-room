import { createContext, useContext, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { Actions } from "../lib/actions";
import type { AppState } from "../lib/state";
import type { Store } from "../lib/store";

interface AppContextValue {
  store: Store<AppState>;
  actions: Actions;
  isMock: boolean;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider(props: AppContextValue & { children: ReactNode }) {
  const { children, ...value } = props;
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("AppProvider missing");
  return ctx;
}

/**
 * 订阅状态的一部分。
 * 结果按状态对象缓存：状态没变就返回上一次的结果，所以 selector 里可以安全地 filter / sort
 * （否则每次都返回新数组，useSyncExternalStore 会无限重渲染）。
 */
export function useAppState<T>(selector: (s: AppState) => T): T {
  const { store } = useApp();
  const cache = useRef<{ state: AppState; selector: (s: AppState) => T; value: T } | null>(null);
  const getSnapshot = () => {
    const state = store.get();
    const c = cache.current;
    if (c && c.state === state && c.selector === selector) return c.value;
    const value = selector(state);
    cache.current = { state, selector, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot);
}

export const useActions = () => useApp().actions;
export const useIsMock = () => useApp().isMock;
