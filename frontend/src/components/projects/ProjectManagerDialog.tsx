import { useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, FolderKanban, FolderPlus, Loader2, Pencil } from "lucide-react";
import type { Project } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

export interface ProjectManagerDialogProps {
  open: boolean;
  createOnOpen?: boolean;
  projects: readonly Project[];
  activeProjectId?: string;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { name: string; description: string }) => Promise<void>;
  onUpdate: (input: { projectId: string; name: string; description: string }) => Promise<void>;
  onArchive: (project: Project) => Promise<void>;
  onRestore: (project: Project) => Promise<void>;
}

export function ProjectManagerDialog(props: ProjectManagerDialogProps) {
  const [selectedId, setSelectedId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [archiveTarget, setArchiveTarget] = useState<Project>();
  const sorted = useMemo(() => [...props.projects].sort((left, right) => {
    if (Boolean(left.archivedAt) !== Boolean(right.archivedAt)) return left.archivedAt ? 1 : -1;
    return left.name.localeCompare(right.name);
  }), [props.projects]);
  const selected = props.projects.find((project) => project.id === selectedId);

  useEffect(() => {
    if (!props.open) return;
    const nextCreating = Boolean(props.createOnOpen);
    const next = props.projects.find((project) => project.id === props.activeProjectId) ?? props.projects[0];
    setCreating(nextCreating);
    setSelectedId(next?.id);
    setName(nextCreating ? "" : next?.name ?? "");
    setDescription(nextCreating ? "" : next?.description ?? "");
    setBusy(false);
    setError(undefined);
    setArchiveTarget(undefined);
  }, [props.activeProjectId, props.createOnOpen, props.open, props.projects]);

  const choose = (project: Project) => {
    setCreating(false);
    setSelectedId(project.id);
    setName(project.name);
    setDescription(project.description);
    setError(undefined);
  };

  const startCreate = () => {
    setCreating(true);
    setSelectedId(undefined);
    setName("");
    setDescription("");
    setError(undefined);
  };

  const save = async () => {
    const cleanName = name.trim();
    if (!cleanName) { setError("Enter a project name."); return; }
    setBusy(true);
    setError(undefined);
    try {
      if (creating) await props.onCreate({ name: cleanName, description: description.trim() });
      else if (selected) await props.onUpdate({ projectId: selected.id, name: cleanName, description: description.trim() });
      setCreating(false);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (project: Project) => {
    setBusy(true);
    setError(undefined);
    try { await props.onRestore(project); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBusy(false); }
  };

  const confirmArchive = async () => {
    const project = archiveTarget;
    if (!project) return;
    setArchiveTarget(undefined);
    setBusy(true);
    setError(undefined);
    try { await props.onArchive(project); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <Dialog open={props.open} onOpenChange={(open) => !busy && props.onOpenChange(open)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Manage projects</DialogTitle>
            <DialogDescription>Create, rename, describe, archive, or restore local project workspaces.</DialogDescription>
          </DialogHeader>
          <div className="grid min-h-80 grid-cols-[230px_1fr] overflow-hidden rounded-md border border-border">
            <div className="border-r border-border bg-card/60 p-2">
              <Button variant="secondary" size="sm" className="mb-2 w-full justify-start" onClick={startCreate} disabled={busy}>
                <FolderPlus aria-hidden="true" /> New project
              </Button>
              <div role="listbox" aria-label="Projects" className="grid gap-1">
                {sorted.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    role="option"
                    aria-selected={!creating && project.id === selectedId}
                    onClick={() => choose(project)}
                    className={cn("flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-[11px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring", !creating && project.id === selectedId && "bg-primary/10 text-primary")}
                  >
                    {project.archivedAt ? <Archive className="size-3.5 shrink-0" aria-hidden="true" /> : <FolderKanban className="size-3.5 shrink-0" aria-hidden="true" />}
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    {project.id === props.activeProjectId && <span className="text-[8px] uppercase text-primary">Current</span>}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid content-start gap-4 p-4">
              <div className="flex items-center gap-2">
                {creating ? <FolderPlus className="size-4 text-primary" aria-hidden="true" /> : <Pencil className="size-4 text-primary" aria-hidden="true" />}
                <h3 className="text-[13px] font-medium">{creating ? "Create project" : selected?.name ?? "Select a project"}</h3>
              </div>
              {(creating || selected) && <>
                <div className="grid gap-1.5">
                  <Label htmlFor="project-name">Name</Label>
                  <Input id="project-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus={creating} maxLength={200} disabled={busy || Boolean(selected?.archivedAt)} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="project-description">Description</Label>
                  <textarea id="project-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={4} maxLength={1000} disabled={busy || Boolean(selected?.archivedAt)} className="rounded-md border border-input bg-background px-3 py-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60" />
                </div>
                {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
                <div className="flex items-center gap-2">
                  <Button onClick={() => void save()} disabled={busy || !name.trim() || Boolean(selected?.archivedAt)}>{busy ? <Loader2 className="animate-spin" /> : null}{creating ? "Create project" : "Save changes"}</Button>
                  {!creating && selected?.archivedAt && <Button variant="secondary" onClick={() => void restore(selected)} disabled={busy}><ArchiveRestore aria-hidden="true" /> Restore</Button>}
                  {!creating && selected && !selected.archivedAt && <Button variant="ghost" className="ml-auto text-destructive hover:text-destructive" onClick={() => setArchiveTarget(selected)} disabled={busy}><Archive aria-hidden="true" /> Archive</Button>}
                </div>
              </>}
            </div>
          </div>
          <DialogFooter><Button variant="ghost" onClick={() => props.onOpenChange(false)} disabled={busy}>Done</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(archiveTarget)} onOpenChange={(open) => !open && setArchiveTarget(undefined)}>
        <AlertDialogContent>
          <AlertDialogTitle>Archive “{archiveTarget?.name}”?</AlertDialogTitle>
          <AlertDialogDescription>The project will leave the recent selector, but its sources, SQL, and history remain available for restoration.</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmArchive()}>Archive project</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
