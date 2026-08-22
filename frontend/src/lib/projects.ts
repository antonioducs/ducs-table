import type { Project } from "@/types";

export function recentProjects(projects: readonly Project[]): Project[] {
  return projects
    .filter((project) => !project.archivedAt)
    .sort((left, right) => Date.parse(right.lastOpenedAt || right.updatedAt) - Date.parse(left.lastOpenedAt || left.updatedAt));
}
