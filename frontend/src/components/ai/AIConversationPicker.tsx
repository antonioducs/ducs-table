import { MessageSquarePlus, Trash2 } from "lucide-react";
import type { AIConversation } from "@/types";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function AIConversationPicker({ conversations, value, disabled, onSelect, onCreate, onDelete }: {
  conversations: AIConversation[];
  value?: string;
  disabled?: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Select value={value} onValueChange={onSelect} disabled={disabled || conversations.length === 0}>
        <SelectTrigger aria-label="AI conversation" className="min-w-0 flex-1"><SelectValue placeholder="New conversation" /></SelectTrigger>
        <SelectContent>{conversations.map((conversation) => <SelectItem key={conversation.id} value={conversation.id}>{conversation.title}</SelectItem>)}</SelectContent>
      </Select>
      <Button variant="ghost" size="icon-sm" aria-label="New AI conversation" disabled={disabled} onClick={onCreate}><MessageSquarePlus /></Button>
      <Button variant="ghost" size="icon-sm" aria-label="Delete AI conversation" disabled={disabled || !value} onClick={() => value && onDelete(value)}><Trash2 /></Button>
    </div>
  );
}

