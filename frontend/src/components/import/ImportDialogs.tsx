import { useId, useState } from "react";
import { FileSpreadsheet, LoaderCircle, RotateCcw } from "lucide-react";
import type { ImportOptions, SourceKind, WorkbookSheets } from "@/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

export interface SheetPickerProps {
  workbook: WorkbookSheets;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (sheet: string) => void;
  busy?: boolean;
}

type SheetPickerFormProps = Omit<SheetPickerProps, "open"> & { workbook: WorkbookSheets };

function SheetPickerForm({ workbook, onOpenChange, onConfirm, busy = false }: SheetPickerFormProps) {
  const groupName = useId();
  const [selectedSheet, setSelectedSheet] = useState(workbook.sheets[0] ?? "");
  const selected = workbook.sheets.includes(selectedSheet) ? selectedSheet : (workbook.sheets[0] ?? "");

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selected && !busy) onConfirm(selected);
  }

  return (
    <DialogContent className="max-w-md" hideClose={busy}>
      <form className="grid gap-4" onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>Choose a worksheet</DialogTitle>
          <DialogDescription>
            Select one sheet from <span className="font-medium text-foreground">{workbook.displayName ?? "this workbook"}</span> to import.
          </DialogDescription>
        </DialogHeader>
        <p className="truncate rounded-lg border border-border bg-muted px-2.5 py-2 font-mono text-[10.5px] text-muted-foreground" title={workbook.path}>{workbook.path}</p>
        <ScrollArea className="max-h-64 rounded-md border border-border bg-background">
          <fieldset className="grid gap-0.5 p-1.5" disabled={busy}>
            <legend className="sr-only">Workbook sheets</legend>
            {workbook.sheets.map((sheet, index) => {
              const id = `${groupName}-sheet-${index}`;
              return (
                <label
                  key={`${sheet}-${index}`}
                  htmlFor={id}
                  className="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-[12px] text-foreground transition-colors duration-150 ease-soft hover:bg-accent has-[:checked]:bg-primary/12 has-[:checked]:text-brand-200"
                >
                  <input
                    id={id}
                    type="radio"
                    name={groupName}
                    value={sheet}
                    checked={selected === sheet}
                    onChange={() => setSelectedSheet(sheet)}
                    className="size-3.5 shrink-0 accent-primary"
                  />
                  <FileSpreadsheet className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{sheet}</span>
                </label>
              );
            })}
            {workbook.sheets.length === 0 && <p className="px-2 py-5 text-center text-[11px] text-muted-foreground">No worksheets were found.</p>}
          </fieldset>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={!selected || busy}>
            {busy && <LoaderCircle className="animate-spin" aria-hidden="true" />}
            {busy ? "Importing…" : "Import sheet"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

export function SheetPicker({ workbook, open, onOpenChange, onConfirm, busy = false }: SheetPickerProps) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !busy && onOpenChange(nextOpen)}>
      {open && (
        <SheetPickerForm
          key={`${workbook.path}:${workbook.sheets.join("\u0000")}`}
          workbook={workbook}
          onOpenChange={onOpenChange}
          onConfirm={onConfirm}
          busy={busy}
        />
      )}
    </Dialog>
  );
}

export interface RetryImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind?: SourceKind;
  options?: ImportOptions;
  fileName?: string;
  onConfirm: (options: ImportOptions) => void;
  busy?: boolean;
}

interface OptionProps {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description: string;
  disabled: boolean;
}

function Option({ id, checked, onChange, label, description, disabled }: OptionProps) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-border bg-background/70 px-3 py-2.5 transition-colors duration-150 ease-soft hover:border-border/90 has-[[data-state=checked]]:border-primary/30 has-[[data-state=checked]]:bg-primary/[0.06]">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        disabled={disabled}
        aria-label={label}
        aria-describedby={`${id}-description`}
        className="mt-0.5"
      />
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-[11px] font-medium text-foreground">{label}</span>
        <span id={`${id}-description`} className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">{description}</span>
      </label>
    </div>
  );
}

type RetryFormProps = Omit<RetryImportDialogProps, "open"> & { xlsx: boolean };

function RetryImportForm({ onOpenChange, kind, options, fileName, onConfirm, busy = false, xlsx }: RetryFormProps) {
  const id = useId();
  const [delimiter, setDelimiter] = useState(options?.delimiter ?? (kind === "csv" ? "," : ""));
  const [header, setHeader] = useState(options?.header ?? true);
  const [allVarchar, setAllVarchar] = useState(options?.allVarchar ?? false);
  const [ignoreErrors, setIgnoreErrors] = useState(options?.ignoreErrors ?? false);
  const delimiterValid = xlsx || delimiter === "" || [...delimiter].length === 1;

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!delimiterValid || busy) return;
    const next: ImportOptions = { header, allVarchar };
    if (!xlsx) {
      if (delimiter) next.delimiter = delimiter;
      next.ignoreErrors = ignoreErrors;
    }
    onConfirm(next);
  }

  return (
    <DialogContent className="max-w-md" hideClose={busy}>
      <form className="grid gap-4" onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>Retry import</DialogTitle>
          <DialogDescription>
            Adjust how {fileName ? <span className="font-medium text-foreground">{fileName}</span> : "the file"} is read. The original file will not be changed.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {!xlsx && (
            <div className="rounded-md border border-border bg-background px-3 py-2.5">
              <label htmlFor={`${id}-delimiter`} className="text-[11px] font-medium text-foreground">Delimiter</label>
              <Input
                id={`${id}-delimiter`}
                value={delimiter}
                onChange={(event) => setDelimiter(event.target.value)}
                disabled={busy}
                placeholder="Auto-detect"
                className="mt-1.5 font-mono"
                aria-invalid={!delimiterValid}
                aria-describedby={`${id}-delimiter-help`}
              />
              <p id={`${id}-delimiter-help`} className={delimiterValid ? "mt-1 text-[10px] text-muted-foreground" : "mt-1 text-[10px] text-destructive"}>
                {delimiterValid ? "Leave blank to auto-detect, or enter one character." : "Delimiter must be exactly one character."}
              </p>
            </div>
          )}
          <Option id={`${id}-header`} checked={header} onChange={setHeader} label="First row is a header" description={xlsx ? "Use the first worksheet row as column names." : "Use the first file row as column names."} disabled={busy} />
          <Option id={`${id}-varchar`} checked={allVarchar} onChange={setAllVarchar} label="Read every column as text" description="Avoid type inference when columns contain mixed values." disabled={busy} />
          {!xlsx && <Option id={`${id}-ignore`} checked={ignoreErrors} onChange={setIgnoreErrors} label="Skip malformed rows" description="Continue importing valid rows when a row cannot be parsed." disabled={busy} />}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={!delimiterValid || busy}>
            {busy ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}
            {busy ? "Retrying…" : "Retry import"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

export function RetryImportDialog(props: RetryImportDialogProps) {
  const xlsx = props.kind?.toLowerCase() === "xlsx" || /\.xlsx$/i.test(props.fileName ?? "");
  const busy = props.busy ?? false;
  return (
    <Dialog open={props.open} onOpenChange={(nextOpen) => !busy && props.onOpenChange(nextOpen)}>
      {props.open && <RetryImportForm key={`${props.kind ?? ""}:${JSON.stringify(props.options ?? {})}`} {...props} busy={busy} xlsx={xlsx} />}
    </Dialog>
  );
}
