import { useEffect, useRef } from "react";
import { Bot, ChevronRight, Copy, User } from "lucide-react";
import { toast } from "sonner";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { AIApprovalDecision, AIApprovalRequest, AIMessage } from "@/types";
import type { AIToolActivity } from "@/stores/ai-store";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { bridge } from "@/lib/bridge";
import { copyText } from "@/lib/clipboard";
import { AISQLCard, type AISQLCardProps } from "./AISQLCard";
import { AIToolCard } from "./AIToolCard";
import { AIApprovalCard } from "./AIApprovalCard";

function Markdown({ children, sqlActions }: { children: string; sqlActions: Omit<AISQLCardProps, "sql"> }) {
  const components: Components = {
    code({ className, children: codeChildren, ...props }) {
      const code = String(codeChildren).replace(/\n$/, "");
      if (/language-sql/i.test(className ?? "")) return <AISQLCard sql={code} {...sqlActions} />;
      return <code className={cn("rounded bg-primary/10 px-1 py-0.5 font-mono text-[10.5px] text-brand-200", className)} {...props}>{codeChildren}</code>;
    },
    a({ children: linkChildren, href }) {
      return <a href={href} className="text-primary underline" onClick={(event) => {
        event.preventDefault();
        if (href) bridge.OpenExternalURL(href);
      }}>{linkChildren}</a>;
    },
  };
  return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={components}>{children}</ReactMarkdown>;
}

async function copyMessage(content: string): Promise<void> {
  try {
    await copyText(content);
    toast.success("Message copied");
  } catch {
    toast.error("Could not copy message");
  }
}

export function AIMessageList({ messages, tools, approvals, approvalBusy, onApproval, ...sqlActions }: {
  messages: AIMessage[];
  tools: AIToolActivity[];
  approvals: AIApprovalRequest[];
  approvalBusy?: string;
  onApproval: (approval: AIApprovalRequest, decision: AIApprovalDecision) => void;
} & Omit<AISQLCardProps, "sql">) {
  const endRef = useRef<HTMLDivElement>(null);
  const contentSize = messages.reduce((size, message) => size + message.content.length + (message.reasoning?.length ?? 0), 0) + tools.length + approvals.length;
  useEffect(() => {
    if (typeof endRef.current?.scrollIntoView === "function") endRef.current.scrollIntoView({ block: "end" });
  }, [contentSize]);

  if (messages.length === 0 && approvals.length === 0) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center p-6 text-center">
        <div className="ducs-rise">
          <span className="relative mx-auto grid size-12 place-items-center">
            <span aria-hidden="true" className="absolute inset-0 rounded-2xl border border-primary/20 animate-ducs-breathe" />
            <span className="ducs-glass-card relative grid size-11 place-items-center rounded-xl text-primary"><Bot className="size-5" /></span>
          </span>
          <p className="ducs-display mt-3 text-[13px] text-foreground">Ask for analysis or SQL</p>
          <p className="mx-auto mt-1.5 max-w-56 text-[10.5px] leading-4 text-muted-foreground">AI can inspect project metadata and run read-only previews after your authorization.</p>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-3 p-3">
        {messages.map((message) => {
          const messageTools = tools.filter((tool) => tool.messageId === message.id);
          return (
            <article key={message.id} className={cn("ducs-selectable-text animate-ducs-rise text-[11.5px]", message.role === "user" && "ml-5 rounded-xl border border-primary/20 bg-gradient-to-br from-primary/[0.14] to-primary/[0.05] p-2.5 shadow-[inset_0_1px_0_rgba(215,255,235,.05)]")}>
              <div className="ducs-eyebrow mb-1.5 flex items-center gap-1.5 text-muted-foreground/80">
                {message.role === "user" ? <User className="size-3" /> : <Bot className="size-3 text-primary" />}{message.role}
                {message.status === "streaming" && <span className="ducs-live-dot ml-0.5" aria-hidden="true" />}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto size-5"
                  aria-label={`Copy ${message.role} message`}
                  title="Copy message"
                  disabled={!message.content}
                  onClick={() => void copyMessage(message.content)}
                >
                  <Copy className="size-3" aria-hidden="true" />
                </Button>
              </div>
              {message.reasoning && <details className="group/reason mb-2 rounded-lg border border-border bg-muted/40 p-2 text-[10.5px] text-muted-foreground transition-colors hover:border-border/80"><summary className="flex cursor-pointer list-none items-center gap-1.5 select-none"><ChevronRight className="size-3 transition-transform duration-200 ease-soft group-open/reason:rotate-90" />Reasoning</summary><p className="mt-1 whitespace-pre-wrap">{message.reasoning}</p></details>}
              {message.content && <div className="ai-markdown break-words leading-5"><Markdown sqlActions={sqlActions}>{message.content}</Markdown></div>}
              {message.error && <p role="alert" className="mt-1 text-destructive">{message.error}</p>}
              {messageTools.map((tool) => <AIToolCard key={tool.toolCallId} tool={tool} {...sqlActions} />)}
            </article>
          );
        })}
        {approvals.map((approval) => <AIApprovalCard key={approval.id} approval={approval} busy={approvalBusy === approval.id} onRespond={(decision) => onApproval(approval, decision)} />)}
        <div ref={endRef} />
      </div>
    </ScrollArea>
  );
}
