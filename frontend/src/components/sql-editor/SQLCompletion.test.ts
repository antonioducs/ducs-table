import { describe, expect, it } from "vitest";
import { sqlCompletionOptions } from "./completion";
import type { ExternalRelationInfo, SourceInfo } from "@/types";

describe("SQL completion catalog", () => {
  it("quotes local and segmented external relation names", () => {
    const source: SourceInfo = { projectId:"project-1",id:"local",displayName:"Local",tableName:'odd"table',kind:"csv",rowCount:1,status:"ready",isEphemeral:false,columns:[] };
    const relation: ExternalRelationInfo = { id:"remote",connectionId:"conn",provider:"postgres",catalog:'Prod DB',schema:'Sales"Ops',name:"Order",relationType:"view",qualifiedName:"",columns:[{name:"customer id",type:"INTEGER",nullable:true,ordinal:1}],defaultOrder:[],pagingStable:false };
    const options = sqlCompletionOptions([source],[relation]);
    expect(options.find((option) => option.label === source.tableName)?.apply).toBe('"odd""table"');
    expect(options.find((option) => option.label === 'Prod DB.Sales"Ops.Order')?.apply).toBe('"Prod DB"."Sales""Ops"."Order"');
    expect(options.some((option) => option.label === "customer id")).toBe(true);
  });
});
