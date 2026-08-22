import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat().format(value);
}

export function formatBytes(value: number | undefined): string {
  if (value === undefined || value < 0) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let current = value / 1024;
  let index = 0;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current.toFixed(current >= 10 ? 1 : 2)} ${units[index]}`;
}

export function formatElapsed(start?: string, end?: string, now = Date.now()): string {
  if (!start) return "Waiting";
  const startMs = Date.parse(start);
  const endMs = end ? Date.parse(end) : now;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "—";
  const seconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function quoteQualifiedIdentifier(parts: readonly string[]): string {
  return parts.map(quoteIdentifier).join(".");
}
