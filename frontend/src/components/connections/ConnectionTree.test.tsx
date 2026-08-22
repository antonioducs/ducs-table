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
    await user.click(screen.getByRole("button",{name:"Expand Production"}));
    expect(onExpandConnection).toHaveBeenCalledWith(connection);
    await user.click(screen.getByRole("button",{name:/public/i}));
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
});
