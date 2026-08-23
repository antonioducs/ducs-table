import type { AIModel, AIProvider } from "@/types";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function aiEffortOptions(model: AIModel | undefined, provider: AIProvider): string[] {
  const raw = record(model?.raw);
  if (raw.supportsEffort === false || raw.supports_effort === false) return [];
  const candidates = [raw.supportedReasoningEfforts, raw.supported_reasoning_efforts, raw.supportedEffortLevels, raw.supported_effort_levels];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const values = candidate.flatMap((item) => {
      if (typeof item === "string") return [item];
      const value = record(item);
      const effort = value.reasoningEffort ?? value.reasoning_effort ?? value.id ?? value.value ?? value.name;
      return typeof effort === "string" ? [effort] : [];
    }).filter(Boolean);
    if (values.length) return [...new Set(values)];
  }
  return provider === "claude" ? ["low", "medium", "high", "max"] : ["low", "medium", "high", "xhigh"];
}
