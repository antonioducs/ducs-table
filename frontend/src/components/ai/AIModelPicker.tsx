import type { AIModel } from "@/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function AIModelPicker({ models, value, disabled, onChange }: { models: AIModel[]; value?: string; disabled?: boolean; onChange: (value: string) => void }) {
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled || models.length === 0}>
      <SelectTrigger aria-label="AI model" className="min-w-0"><SelectValue placeholder={models.length ? "Choose model" : "No models"} /></SelectTrigger>
      <SelectContent>{models.map((model) => <SelectItem key={model.id} value={model.id}>{model.name || model.id}</SelectItem>)}</SelectContent>
    </Select>
  );
}

