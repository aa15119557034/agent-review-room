import type { ModelOption, RunModel } from "@room/schemas";

/**
 * 模型选择（S-22，契约 C-40）：把 StartRun.model 翻译成 CLI 参数。
 *
 * 参数只来自节点配置里的映射：profile.modelArgs / effortArgs 里的 {model} / {effort} 换成
 * 请求里的 id。id 已经过 ModelId / EffortId 校验，并且必须在 profile.models 的清单里，
 * 所以拼出来的值只可能是配置里写过的模型名和档位名。
 */

/** profile.args 里放这个标记的位置插入模型参数；没有标记就加在最后 */
export const MODEL_ARGS_MARKER = "{model-args}";

export interface ModelProfile {
  args: string[];
  models: ModelOption[];
  modelArgs: string[];
  effortArgs: string[];
}

/** 请求里的模型和档位必须在清单里，不换模型、不就近取档。返回 null 表示可以用 */
export function checkModel(profile: Pick<ModelProfile, "models">, model: RunModel): string | null {
  if (profile.models.length === 0) return "this profile has a fixed model";
  const option = profile.models.find((m) => m.id === model.model);
  if (!option) return `model ${model.model} is not available on this profile`;
  if (model.effort === null) {
    return option.efforts.length === 0 ? null : `model ${model.model} needs an effort level`;
  }
  if (!option.efforts.some((e) => e.id === model.effort)) {
    return `effort ${model.effort} is not available for model ${model.model}`;
  }
  return null;
}

/** 这次运行实际的参数。没指定模型时用 profile 自带的（去掉标记） */
export function buildArgs(profile: ModelProfile, model?: RunModel): string[] {
  const extra: string[] = [];
  if (model) {
    extra.push(...profile.modelArgs.map((a) => a.replaceAll("{model}", model.model)));
    if (model.effort !== null) extra.push(...profile.effortArgs.map((a) => a.replaceAll("{effort}", model.effort!)));
  }
  const at = profile.args.indexOf(MODEL_ARGS_MARKER);
  if (at === -1) return [...profile.args, ...extra];
  return [...profile.args.slice(0, at), ...extra, ...profile.args.slice(at + 1)];
}

/** 配置检查（启动时）：映射和清单要配得上 */
export function modelConfigProblems(profile: ModelProfile): string[] {
  const problems: string[] = [];
  const markers = profile.args.filter((a) => a === MODEL_ARGS_MARKER).length;
  if (markers > 1) problems.push(`args 里的 ${MODEL_ARGS_MARKER} 只能出现一次`);
  if (profile.args.some((a) => a !== MODEL_ARGS_MARKER && /\{(model|effort|model-args)\}/.test(a))) {
    problems.push("args 里不能直接写 {model} / {effort}，要写在 modelArgs / effortArgs 里");
  }
  if (profile.models.length === 0) {
    if (profile.modelArgs.length > 0 || profile.effortArgs.length > 0) {
      problems.push("写了 modelArgs / effortArgs 但没有 models 清单");
    }
    return problems;
  }
  if (!profile.modelArgs.some((a) => a.includes("{model}"))) problems.push("有 models 清单时 modelArgs 必须包含 {model}");
  if (profile.modelArgs.some((a) => a.includes("{effort}"))) problems.push("{effort} 要写在 effortArgs 里");
  if (profile.effortArgs.some((a) => a.includes("{model}"))) problems.push("{model} 要写在 modelArgs 里");
  const hasEfforts = profile.models.some((m) => m.efforts.length > 0);
  if (hasEfforts && !profile.effortArgs.some((a) => a.includes("{effort}"))) {
    problems.push("有带强度档位的模型时 effortArgs 必须包含 {effort}");
  }
  if (!hasEfforts && profile.effortArgs.length > 0) problems.push("所有模型都没有强度档位，effortArgs 应该为空");
  return problems;
}
