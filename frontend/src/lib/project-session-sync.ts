import { bridge } from "@/lib/bridge";
import type { ProjectSession } from "@/types";

type PendingSave = {
  session: ProjectSession;
  serialized: string;
  timer?: ReturnType<typeof setTimeout>;
  onError?: (error: unknown) => void;
};

const pending = new Map<string, PendingSave>();
const saved = new Map<string, string>();

function snapshot(session: ProjectSession): ProjectSession {
  return {
    ...session,
    tabs: session.tabs.map((tab) => ({ ...tab })),
    history: session.history.map((entry) => ({ ...entry })).slice(0, 20),
  };
}

export function markProjectSessionSaved(projectId: string, session: ProjectSession): void {
  saved.set(projectId, JSON.stringify(session));
  const queued = pending.get(projectId);
  if (queued?.timer) clearTimeout(queued.timer);
  pending.delete(projectId);
}

export function scheduleProjectSessionSave(
  projectId: string,
  session: ProjectSession,
  onError?: (error: unknown) => void,
  delay = 500,
): void {
  const copy = snapshot(session);
  const serialized = JSON.stringify(copy);
  if (serialized === saved.get(projectId)) return;
  const current = pending.get(projectId);
  if (current?.timer) clearTimeout(current.timer);
  const next: PendingSave = { session: copy, serialized, onError };
  next.timer = setTimeout(() => {
    next.timer = undefined;
    void flushProjectSession(projectId).catch(() => undefined);
  }, delay);
  pending.set(projectId, next);
}

export async function flushProjectSession(projectId: string, latestSession?: ProjectSession): Promise<void> {
  if (latestSession) {
    const copy = snapshot(latestSession);
    const serialized = JSON.stringify(copy);
    if (serialized !== saved.get(projectId)) {
      const current = pending.get(projectId);
      if (current?.timer) clearTimeout(current.timer);
      pending.set(projectId, { session: copy, serialized, onError: current?.onError });
    }
  }
  const queued = pending.get(projectId);
  if (!queued) return;
  if (queued.timer) clearTimeout(queued.timer);
  pending.delete(projectId);
  try {
    await bridge.SaveProjectSession({ projectId, session: queued.session });
    saved.set(projectId, queued.serialized);
  } catch (error) {
    queued.onError?.(error);
    throw error;
  }
}

export async function flushAllProjectSessions(): Promise<void> {
  await Promise.all([...pending.keys()].map((projectId) => flushProjectSession(projectId)));
}

export function resetProjectSessionSync(): void {
  for (const save of pending.values()) if (save.timer) clearTimeout(save.timer);
  pending.clear();
  saved.clear();
}
