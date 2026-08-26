import { Fragment, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { ProjectLayoutNode } from "@/types";
import type { LayoutPath } from "@/lib/workbench";

export interface WorkbenchLayoutProps {
  layout: ProjectLayoutNode;
  renderGroup: (groupId: string) => ReactNode;
  onResize: (path: LayoutPath, sizes: number[]) => void;
}

function pathKey(path: LayoutPath): string {
  return path.length ? path.join("-") : "root";
}

function renderNode(
  node: ProjectLayoutNode,
  path: LayoutPath,
  renderGroup: WorkbenchLayoutProps["renderGroup"],
  onResize: WorkbenchLayoutProps["onResize"],
): ReactNode {
  if (node.kind === "group") return node.groupId ? renderGroup(node.groupId) : null;
  const children = node.children ?? [];
  return (
    <PanelGroup
      // Remounting on structure change keeps persisted sizes authoritative.
      key={`split:${pathKey(path)}:${children.length}:${children.map((child) => child.groupId ?? "split").join(",")}`}
      direction={node.direction === "vertical" ? "vertical" : "horizontal"}
      onLayout={(sizes) => onResize(path, sizes)}
    >
      {children.map((child, index) => (
        <Fragment key={child.groupId ?? `split-${index}`}>
          {index > 0 && (
            <PanelResizeHandle
              className={node.direction === "vertical"
                ? "h-1 bg-border transition-colors hover:bg-primary/50 focus-visible:bg-primary"
                : "w-1 bg-border transition-colors hover:bg-primary/50 focus-visible:bg-primary"}
            />
          )}
          <Panel defaultSize={child.size ?? 100 / children.length} minSize={12}>
            {renderNode(child, [...path, index], renderGroup, onResize)}
          </Panel>
        </Fragment>
      ))}
    </PanelGroup>
  );
}

/** Renders the persisted split tree; every leaf delegates to `renderGroup`. */
export function WorkbenchLayout({ layout, renderGroup, onResize }: WorkbenchLayoutProps) {
  return <div className="h-full min-h-0">{renderNode(layout, [], renderGroup, onResize)}</div>;
}
