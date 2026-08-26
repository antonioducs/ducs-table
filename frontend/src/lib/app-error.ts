import type { AppErrorInfo } from "@/types";

export interface AppErrorPresentation {
  message: string;
  stage?: string;
  suggestion?: string;
  errorRef?: string;
  shortErrorRef?: string;
  logPath?: string;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function shortErrorReference(errorRef: string): string {
  const normalized = errorRef.trim();
  return normalized.length > 12 ? normalized.slice(0, 8) : normalized;
}

export function presentAppError(error: AppErrorInfo | undefined, fallbackMessage: string, fallbackStage?: string): AppErrorPresentation {
  const message = text(error?.message) ?? fallbackMessage;
  const stage = text(error?.details?.stage) ?? text(fallbackStage);
  const rawSuggestion = text(error?.details?.suggestion);
  const errorRef = text(error?.details?.errorRef);
  return {
    message,
    stage: stage === message ? undefined : stage,
    suggestion: rawSuggestion === message ? undefined : rawSuggestion,
    errorRef,
    shortErrorRef: errorRef ? shortErrorReference(errorRef) : undefined,
    logPath: text(error?.details?.logPath),
  };
}

export function appErrorToastDescription(error: AppErrorPresentation): string | undefined {
  const parts = [
    error.suggestion,
    error.stage ? `Stage: ${error.stage}` : undefined,
    error.shortErrorRef ? `Reference: ${error.shortErrorRef}` : undefined,
    error.logPath ? `Log: ${error.logPath}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" · ") : undefined;
}

/** Tracks one toast per import lifecycle while both backend failure events update application state. */
export class ImportFailureToastDeduper {
  private readonly notified = new Set<string>();

  shouldNotify(projectId: string, sourceId: string): boolean {
    const key = `${projectId}:${sourceId}`;
    if (this.notified.has(key)) return false;
    this.notified.add(key);
    return true;
  }

  reset(projectId: string, sourceId: string): void {
    this.notified.delete(`${projectId}:${sourceId}`);
  }
}
