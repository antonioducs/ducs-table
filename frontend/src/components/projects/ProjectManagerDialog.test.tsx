import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "@/types";
import { ProjectManagerDialog } from "./ProjectManagerDialog";

const active: Project = { id: "active", name: "Active project", description: "Current description", lastOpenedAt: "", createdAt: "", updatedAt: "" };
const archived: Project = { id: "archived", name: "Old project", description: "", archivedAt: "2026-08-20T00:00:00Z", lastOpenedAt: "", createdAt: "", updatedAt: "" };

function props() {
  return {
    open: true,
    projects: [active, archived],
    activeProjectId: active.id,
    onOpenChange: vi.fn(),
    onCreate: vi.fn().mockResolvedValue(undefined),
    onUpdate: vi.fn().mockResolvedValue(undefined),
    onArchive: vi.fn().mockResolvedValue(undefined),
    onRestore: vi.fn().mockResolvedValue(undefined),
  };
}

describe("ProjectManagerDialog", () => {
  it("creates and updates named project workspaces", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    const { rerender } = render(<ProjectManagerDialog {...callbacks} createOnOpen />);
    await user.type(screen.getByLabelText("Name"), "Fresh project");
    await user.type(screen.getByLabelText("Description"), "A clean workspace");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    expect(callbacks.onCreate).toHaveBeenCalledWith({ name: "Fresh project", description: "A clean workspace" });

    rerender(<ProjectManagerDialog {...callbacks} createOnOpen={false} />);
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Renamed project");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(callbacks.onUpdate).toHaveBeenCalledWith({ projectId: "active", name: "Renamed project", description: "Current description" });
  });

  it("confirms archive and restores without exposing hard delete", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    render(<ProjectManagerDialog {...callbacks} />);
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Archive" }));
    expect(screen.getByText("Archive “Active project”?" )).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Archive project" }));
    expect(callbacks.onArchive).toHaveBeenCalledWith(active);

    await user.click(screen.getByRole("option", { name: /Old project/ }));
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(callbacks.onRestore).toHaveBeenCalledWith(archived);
  });
});
