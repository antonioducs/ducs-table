import { Brain, Send, Square, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import type { AIConfig, AIModelOption, AIProvider } from "@/types";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { aiEffortOptions } from "./ai-model-capabilities";

function modelOptionValue(option: AIModelOption): string {
  return JSON.stringify([option.provider, option.model.id]);
}

export function AIComposer({ disabled, modelSelectionDisabled, running, placeholder, config, models, onModelChange, onEffortChange, onFastModeChange, onSend, onStop }: {
  disabled?: boolean;
  modelSelectionDisabled?: boolean;
  running?: boolean;
  placeholder?: string;
  config?: AIConfig;
  models: AIModelOption[];
  onModelChange: (provider: AIProvider, model: string) => void;
  onEffortChange: (effort?: string) => void;
  onFastModeChange: (enabled: boolean) => void;
  onSend: (prompt: string) => void;
  onStop: () => void;
}) {
  const [value, setValue] = useState("");
  const selectedModel = models.find((option) => option.provider === config?.provider && option.model.id === config.model);
  const efforts = useMemo(() => aiEffortOptions(selectedModel?.model, selectedModel?.provider ?? config?.provider ?? "codex"), [config?.provider, selectedModel]);
  const submit = () => {
    const prompt = value.trim();
    if (!prompt || disabled || running) return;
    setValue("");
    onSend(prompt);
  };
  return (
    <div className="ducs-glass-bar border-t border-border bg-card p-2">
      <div className="rounded-xl border border-white/10 bg-black/25 px-2.5 pb-2 pt-2 shadow-[inset_0_1px_0_rgba(255,255,255,.035),0_12px_32px_rgba(0,0,0,.16)] backdrop-blur-xl focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-ring/70">
        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
          }}
          aria-label="Message AI"
          placeholder={placeholder ?? "Ask about this project…"}
          disabled={disabled}
          rows={4}
          className="w-full resize-none bg-transparent px-0.5 py-1 text-[12px] leading-5 outline-none placeholder:text-muted-foreground disabled:opacity-50"
        />
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1 border-t border-border/60 pt-1.5">
          <Select
            value={config?.reasoningEffort || "default"}
            onValueChange={(effort) => onEffortChange(effort === "default" ? undefined : effort)}
            disabled={disabled || running || efforts.length === 0}
          >
            <SelectTrigger aria-label="AI effort" className="h-7 w-auto min-w-20 gap-1 border-0 bg-transparent px-1.5 text-[10px] shadow-none hover:bg-accent">
              <Brain className="size-3.5 text-violet-400" /><SelectValue placeholder="Effort" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">Default effort</SelectItem>
              {efforts.map((effort) => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}
            </SelectContent>
          </Select>

          <button
            type="button"
            aria-label="Fast mode"
            aria-pressed={Boolean(config?.fastMode)}
            disabled={disabled || running}
            onClick={() => onFastModeChange(!config?.fastMode)}
            className={cn(
              "flex h-7 items-center gap-1 rounded-md px-1.5 text-[10px] transition-colors disabled:opacity-40",
              config?.fastMode ? "bg-amber-500/15 text-amber-300 hover:bg-amber-500/20" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Zap className={cn("size-3.5", config?.fastMode && "fill-current")} />Fast
          </button>

          <Select
            value={selectedModel ? modelOptionValue(selectedModel) : undefined}
            onValueChange={(nextValue) => {
              const option = models.find((candidate) => modelOptionValue(candidate) === nextValue);
              if (option) onModelChange(option.provider, option.model.id);
            }}
            disabled={(modelSelectionDisabled ?? disabled) || running || models.length === 0}
          >
            <SelectTrigger aria-label="Composer AI model" className="h-7 min-w-0 flex-1 gap-1 border-0 bg-transparent px-1.5 text-[10px] shadow-none hover:bg-accent">
              <SelectValue placeholder="Choose model" />
            </SelectTrigger>
            <SelectContent>
              {models.map((option) => (
                <SelectItem key={modelOptionValue(option)} value={modelOptionValue(option)}>
                  {option.provider === "claude" ? "Claude" : "Codex"} · {option.model.name || option.model.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="ml-auto shrink-0">
            {running
              ? <Button variant="destructive" size="sm" className="h-8" onClick={onStop}><Square /> Stop</Button>
              : <Button size="sm" className="h-8" disabled={disabled || !value.trim()} onClick={submit}><Send /> Send</Button>}
          </div>
        </div>
      </div>
    </div>
  );
}
