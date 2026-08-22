import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionInfo } from "@/types";
import { ConnectionAttachDialog } from "./ConnectionAttachDialog";
import { ConnectionManagerDialog } from "./ConnectionManagerDialog";

const connection: ConnectionInfo = {
  id: "global-1", name: "Shared warehouse", kind: "postgres", catalogName: "warehouse", config: { postgres: { host: "localhost", port: 5432, database: "db", username: "reader", sslMode: "prefer", connectTimeoutSeconds: 10, poolSize: 4 } },
  autoConnect: false, hasSecret: true, status: "disconnected", createdAt: "", updatedAt: "",
};

describe("connection attachment and global management", () => {
  it("reuses an unattached global connection or starts a new one", async () => {
    const user = userEvent.setup();
    const onAttach = vi.fn();
    const onNew = vi.fn();
    const onManage = vi.fn();
    render(<ConnectionAttachDialog open projectName="Analytics" availableConnections={[connection]} onOpenChange={vi.fn()} onAttach={onAttach} onNew={onNew} onManage={onManage} />);
    expect(screen.getByText("Add connection to Analytics")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Attach Shared warehouse" }));
    expect(onAttach).toHaveBeenCalledWith(connection);
    await user.click(screen.getByRole("button", { name: "New connection" }));
    await user.click(screen.getByRole("button", { name: "Manage global connections" }));
    expect(onNew).toHaveBeenCalledOnce();
    expect(onManage).toHaveBeenCalledOnce();
  });

  it("requires usage lookup and exact name before deleting everywhere", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const onUsageCount = vi.fn().mockResolvedValue(3);
    render(<ConnectionManagerDialog open connections={[connection]} onOpenChange={vi.fn()} onEdit={vi.fn()} onUsageCount={onUsageCount} onDelete={onDelete} />);
    await user.click(screen.getByRole("button", { name: "Delete everywhere" }));
    await waitFor(() => expect(screen.getByText(/attached to 3 projects/)).toBeInTheDocument());
    const confirm = screen.getByRole("button", { name: "Delete everywhere" });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText("Connection deletion confirmation"), "Shared warehouse");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onDelete).toHaveBeenCalledWith(connection);
  });
});
