import type { SelectOption } from "../shared/CustomSelect.js";

const REASONING_OPTIONS: SelectOption[] = [
  { value: "", label: "跟随请求", meta: "CompactGate 不覆盖 reasoning.effort" },
  { value: "low", label: "low", meta: "轻量推理，延迟优先" },
  { value: "medium", label: "medium", meta: "平衡质量与延迟" },
  { value: "high", label: "high", meta: "复杂任务，增加推理预算" },
  { value: "xhigh", label: "xhigh", meta: "更深推理，质量优先" },
  { value: "max", label: "max", meta: "最高推理强度" }
];

export function primaryReasoningOptions(): SelectOption[] {
  return REASONING_OPTIONS;
}

export function primaryModelOptions(
  models: string[],
  currentModel: string
): SelectOption[] {
  const uniqueModels = [...new Set(models.map((model) => model.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  const options: SelectOption[] = [
    {
      value: "",
      label: "跟随请求",
      meta: "不覆盖客户端传入的 model"
    },
    ...uniqueModels.map((model) => ({
      value: model,
      label: model,
      meta: "来自当前 Primary 上游"
    }))
  ];
  const normalizedCurrent = currentModel.trim();

  if (normalizedCurrent && !uniqueModels.includes(normalizedCurrent)) {
    options.push({
      value: currentModel,
      label: currentModel,
      meta: models.length > 0 ? "当前自定义值" : "拉取后可从上游列表选择"
    });
  }

  return options;
}
