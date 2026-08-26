import { appErrorToastDescription, presentAppError } from "@/lib/app-error";
import type { AppErrorInfo } from "@/types";

type CallbackPayload = {
  error?: unknown;
  [key: string]: unknown;
};

function structuredMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try { return structuredMessage(JSON.parse(trimmed)); } catch { /* Keep the original string. */ }
    }
    return trimmed;
  }
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const message = structuredMessage(raw.message ?? raw.Message ?? raw.error ?? raw.Error);
  const code = typeof (raw.code ?? raw.Code) === "string" ? String(raw.code ?? raw.Code).trim() : "";
  const base = message && code && !message.startsWith(`[${code}]`) ? `[${code}] ${message}` : message ?? (code ? `[${code}] The operation failed.` : undefined);
  const details = raw.details ?? raw.Details;
  if (base && details && typeof details === "object") {
    const presented = presentAppError({ code: code || undefined, message: message ?? "The operation failed.", details: details as AppErrorInfo["details"] }, message ?? "The operation failed.");
    const description = appErrorToastDescription(presented);
    if (description) return `${base} — ${description}`;
  }
  return base;
}

// Wails v2.15 wraps callback errors with new Error(payload.error). Structured
// Go errors therefore become "[object Object]" unless converted to a string
// before the runtime callback handles them.
export function normalizeWailsCallbackPayload(message: string): string {
  try {
    const payload = JSON.parse(message) as CallbackPayload;
    if (payload.error) {
      payload.error = structuredMessage(payload.error) ?? "The operation failed.";
      return JSON.stringify(payload);
    }
  } catch {
    // Let the Wails runtime report malformed callback JSON itself.
  }
  return message;
}

export function installWailsErrorNormalizer(): void {
  const wails = window.wails;
  const callback = wails?.Callback;
  if (!wails || !callback || wails.errorNormalizerInstalled) return;
  wails.errorNormalizerInstalled = true;
  wails.Callback = (message: string) => callback(normalizeWailsCallbackPayload(message));
}
