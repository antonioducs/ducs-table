import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridge } from "@/lib/bridge";
import type { ConnectionInfo } from "@/types";
import { ConnectionDialog } from "./ConnectionDialog";

const saved: ConnectionInfo = {
  id:"conn",name:"Production",kind:"postgres",catalogName:"prod",autoConnect:false,hasSecret:true,status:"disconnected",
  config:{postgres:{host:"localhost",port:5432,database:"app",username:"reader",sslMode:"prefer",connectTimeoutSeconds:10,poolSize:4}},
  createdAt:"2026-08-21T00:00:00Z",updatedAt:"2026-08-21T00:00:00Z",
};

describe("ConnectionDialog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows stable and experimental providers and never prefills an edited password", () => {
    render(<ConnectionDialog open onOpenChange={vi.fn()} connection={saved} onSaved={vi.fn()} />);
    expect(screen.getByText("Stable")).toBeInTheDocument();
    expect(screen.getByText("Experimental")).toBeInTheDocument();
    expect(screen.getByLabelText("Connection password")).toHaveValue("");
    expect(screen.getByLabelText("SQL catalog alias")).toBeDisabled();
  });

  it("switches to MongoDB fields behind explicit experimental consent", async () => {
    const user=userEvent.setup();render(<ConnectionDialog open projectId="project-1" onOpenChange={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByRole("button",{name:/MongoDB/i}));
    expect(screen.getByLabelText("MongoDB hosts")).toBeInTheDocument();
    expect(screen.getByLabelText("MongoDB database")).toBeInTheDocument();
    expect(screen.getByText(/Experimental MongoDB support/)).toBeInTheDocument();
    expect(screen.getByRole("button",{name:/Save & connect/i})).toBeDisabled();
  });

  it("tests, saves, and connects a PostgreSQL configuration", async () => {
    const user = userEvent.setup(); const onSaved = vi.fn(); const onOpenChange = vi.fn();
    vi.spyOn(bridge,"TestConnection").mockResolvedValue();
    vi.spyOn(bridge,"CreateConnection").mockResolvedValue(saved);
    vi.spyOn(bridge,"ConnectConnection").mockResolvedValue({ ...saved, status:"connected" });
    render(<ConnectionDialog open projectId="project-1" onOpenChange={onOpenChange} onSaved={onSaved} />);
    await user.type(screen.getByLabelText("Connection name"),"Production");
    await user.type(screen.getByLabelText("SQL catalog alias"),"prod");
    await user.type(screen.getByLabelText("PostgreSQL database"),"app");
    await user.type(screen.getByLabelText("PostgreSQL username"),"reader");
    await user.type(screen.getByLabelText("Connection password"),"secret");
    await user.click(screen.getByRole("button",{name:/Test connection/i}));
    expect(await screen.findByText(/Connection succeeded/)).toBeInTheDocument();
    expect(bridge.TestConnection).toHaveBeenCalledWith(expect.objectContaining({ password:"secret" }));
    await user.click(screen.getByRole("button",{name:/Save & connect/i}));
    await waitFor(() => expect(bridge.ConnectConnection).toHaveBeenCalledWith({ projectId: "project-1", id: "conn" }));
    expect(onSaved).toHaveBeenLastCalledWith(expect.objectContaining({ status:"connected" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
