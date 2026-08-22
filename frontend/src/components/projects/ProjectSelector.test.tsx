import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "@/types";
import { ProjectSelector } from "./ProjectSelector";

const projects: Project[] = [
  { id: "older", name: "Older", description: "", lastOpenedAt: "2026-08-20T00:00:00Z", createdAt: "", updatedAt: "" },
  { id: "recent", name: "Recent", description: "", lastOpenedAt: "2026-08-22T00:00:00Z", createdAt: "", updatedAt: "" },
  { id: "archived", name: "Archived", description: "", archivedAt: "2026-08-22T01:00:00Z", lastOpenedAt: "2026-08-21T00:00:00Z", createdAt: "", updatedAt: "" },
];

describe("ProjectSelector", () => {
  it("lists active projects by recent use, marks current, and exposes management actions", async () => {
    const user = userEvent.setup();
    const onNew = vi.fn();
    const onManage = vi.fn();
    render(<ProjectSelector projects={projects} activeProjectId="older" onSelect={vi.fn()} onNew={onNew} onManage={onManage} />);
    await user.click(screen.getByRole("button", { name: "Project: Older" }));
    const projectItems = screen.getAllByRole("menuitem").filter((item) => item.textContent === "Recent" || item.textContent === "Older");
    expect(projectItems.map((item) => item.textContent)).toEqual(["Recent", "Older"]);
    expect(screen.queryByText("Archived")).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Older" })).toHaveAttribute("aria-current", "page");
    await user.click(screen.getByRole("menuitem", { name: "New project" }));
    expect(onNew).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Project: Older" }));
    await user.click(screen.getByRole("menuitem", { name: "Manage projects" }));
    expect(onManage).toHaveBeenCalledOnce();
  });

  it("selects a project from the keyboard", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ProjectSelector projects={projects} activeProjectId="older" onSelect={onSelect} onNew={vi.fn()} onManage={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Project: Older" }));
    const recent = screen.getByRole("menuitem", { name: "Recent" });
    recent.focus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("recent");
  });
});
