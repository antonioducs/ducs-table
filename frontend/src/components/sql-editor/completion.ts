import type { ExternalRelationInfo, SourceInfo } from "@/types";
import { quoteIdentifier, quoteQualifiedIdentifier } from "@/lib/utils";

export function sqlCompletionOptions(sources: SourceInfo[], externalRelations: ExternalRelationInfo[]) {
  return [...sources.flatMap((source) => [
    { label: source.tableName, apply: quoteIdentifier(source.tableName), type: "class", detail: source.displayName, boost: 10 },
    ...source.columns.map((column) => ({ label: column.name, apply: quoteIdentifier(column.name), type: "property", detail: `${source.tableName} · ${column.type}` })),
  ]), ...externalRelations.flatMap((relation) => [
    { label: `${relation.catalog}.${relation.schema}.${relation.name}`, apply: quoteQualifiedIdentifier([relation.catalog, relation.schema, relation.name]), type: "class", detail: `${relation.relationType} · live`, boost: 9 },
    ...relation.columns.map((column) => ({ label: column.name, apply: quoteIdentifier(column.name), type: "property", detail: `${relation.catalog}.${relation.schema}.${relation.name} · ${column.type}` })),
  ])];
}
