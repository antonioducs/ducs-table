import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionInfo, ExternalRelationInfo } from "@/types";
import { ConnectionTree, type ConnectionTreeProps } from "./ConnectionTree";

const connection: ConnectionInfo = { id:"conn",name:"Production",kind:"postgres",catalogName:"prod",config:{postgres:{host:"localhost",port:5432,database:"app",username:"reader",sslMode:"require",connectTimeoutSeconds:10,poolSize:4}},autoConnect:false,hasSecret:true,status:"connected",createdAt:"",updatedAt:"" };
const relation: ExternalRelationInfo = { id:"rel",connectionId:"conn",provider:"postgres",catalog:"prod",schema:"public",name:"customers",relationType:"table",qualifiedName:'"prod"."public"."customers"',columns:[],defaultOrder:[],pagingStable:false };

describe("ConnectionTree", () => {
  it("loads schemas and relations lazily and opens a live relation", async () => {
    const user=userEvent.setup();const onExpandConnection=vi.fn();const onExpandSchema=vi.fn();const onOpenRelation=vi.fn();
    const props:ConnectionTreeProps={connections:[connection],schemasByConnection:{conn:["public"]},relationsBySchema:{"conn:public":[relation]},loading:new Set(),errors:{},onExpandConnection,onExpandSchema,onOpenRelation,onInsertRelation:vi.fn(),onCopyRelation:vi.fn(),onSnapshotRelation:vi.fn(),onConnect:vi.fn(),onDisconnect:vi.fn(),onEdit:vi.fn(),onRefresh:vi.fn(),onRemove:vi.fn()};
    render(<ConnectionTree {...props}/>);
    expect(screen.getByRole("button", { name: "Expand Production" })).toHaveClass("mr-1");
    expect(screen.getByText("Production").closest("button")).toHaveClass("gap-2");
    await user.click(screen.getByRole("button",{name:"Expand Production"}));
    expect(onExpandConnection).toHaveBeenCalledWith(connection);
    await user.click(screen.getByRole("button",{name:"public"}));
    expect(onExpandSchema).toHaveBeenCalledWith(connection,"public");
    await user.click(screen.getByRole("button",{name:"customers"}));
    expect(onOpenRelation).toHaveBeenCalledWith(relation);
  });

  it("removes a reusable connection from only the current project", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    const props:ConnectionTreeProps={connections:[connection],schemasByConnection:{},relationsBySchema:{},loading:new Set(),errors:{},onExpandConnection:vi.fn(),onExpandSchema:vi.fn(),onOpenRelation:vi.fn(),onInsertRelation:vi.fn(),onCopyRelation:vi.fn(),onSnapshotRelation:vi.fn(),onConnect:vi.fn(),onDisconnect:vi.fn(),onEdit:vi.fn(),onRefresh:vi.fn(),onRemove};
    render(<ConnectionTree {...props}/>);
    await user.click(screen.getByRole("button", { name: "Actions for Production" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove from project" }));
    expect(onRemove).toHaveBeenCalledWith(connection);
    expect(screen.queryByText("Delete connection")).not.toBeInTheDocument();
  });

  it("hides schemas and restores them from the hidden-schemas menu", async () => {
    const user = userEvent.setup();
    const props:ConnectionTreeProps={connections:[connection],schemasByConnection:{conn:["public"]},relationsBySchema:{"conn:public":[relation]},loading:new Set(),errors:{},onExpandConnection:vi.fn(),onExpandSchema:vi.fn(),onOpenRelation:vi.fn(),onInsertRelation:vi.fn(),onCopyRelation:vi.fn(),onSnapshotRelation:vi.fn(),onConnect:vi.fn(),onDisconnect:vi.fn(),onEdit:vi.fn(),onRefresh:vi.fn(),onRemove:vi.fn()};
    render(<ConnectionTree {...props}/>);
    await user.click(screen.getByRole("button", { name: "Expand Production" }));

    await user.click(screen.getByRole("button", { name: "Hide schema public" }));
    expect(screen.queryByRole("button", { name: "public" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "1 hidden schema" }));
    await user.click(screen.getByRole("menuitem", { name: "Show Production.public" }));
    expect(screen.getByRole("button", { name: "public" })).toBeInTheDocument();
  });

  it("searches tables across schemas and expands matching results", async () => {
    const user = userEvent.setup();
    const invoice = { ...relation, id: "invoice", schema: "billing", name: "monthly_invoices", qualifiedName: '"prod"."billing"."monthly_invoices"' };
    const props:ConnectionTreeProps={connections:[connection],schemasByConnection:{conn:["public","billing"]},relationsBySchema:{"conn:public":[relation],"conn:billing":[invoice]},loading:new Set(),errors:{},onExpandConnection:vi.fn(),onExpandSchema:vi.fn(),onOpenRelation:vi.fn(),onInsertRelation:vi.fn(),onCopyRelation:vi.fn(),onSnapshotRelation:vi.fn(),onConnect:vi.fn(),onDisconnect:vi.fn(),onEdit:vi.fn(),onRefresh:vi.fn(),onRemove:vi.fn()};
    render(<ConnectionTree {...props}/>);

    await user.type(screen.getByRole("searchbox", { name: "Search connection tables" }), "invoice");
    expect(screen.getByRole("button", { name: "monthly_invoices" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "customers" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "billing" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "public" })).not.toBeInTheDocument();
  });
});
