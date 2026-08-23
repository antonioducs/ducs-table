import { create } from "zustand";
import { bridge, getErrorMessage } from "@/lib/bridge";
import type {
  AIApprovalRequest,
  AIApprovalDecision,
  AIConfig,
  AIConversation,
  AIMessage,
  AIModel,
  AIProvider,
  AIProviderStatus,
  AIRun,
  AIStreamEvent,
} from "@/types";

export interface AIToolActivity {
  toolCallId: string;
  messageId: string;
  name: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  status: "running" | "complete" | "error";
}

interface AIState {
  configByProject: Record<string, AIConfig>;
  providerStatus: Partial<Record<AIProvider, AIProviderStatus>>;
  modelsByProvider: Partial<Record<AIProvider, AIModel[]>>;
  conversationsByProject: Record<string, AIConversation[]>;
  activeConversationByProject: Record<string, string | undefined>;
  messagesByConversation: Record<string, AIMessage[]>;
  toolsByConversation: Record<string, AIToolActivity[]>;
  runsByConversation: Record<string, AIRun | undefined>;
  approvalsByConversation: Record<string, AIApprovalRequest[]>;
  loadingProjects: Record<string, boolean>;
  sendingByConversation: Record<string, boolean>;
  errorByProject: Record<string, string | undefined>;

  initializeProject: (projectId: string) => Promise<void>;
  refreshProvider: (provider: AIProvider) => Promise<void>;
  loginProvider: (provider: AIProvider) => Promise<void>;
  logoutProvider: (provider: AIProvider) => Promise<void>;
  setConfig: (projectId: string, patch: Partial<Pick<AIConfig, "provider" | "model" | "reasoningEffort" | "fastMode">>) => void;
  createConversation: (projectId: string, title?: string) => Promise<AIConversation>;
  selectConversation: (projectId: string, conversationId: string) => Promise<void>;
  deleteConversation: (projectId: string, conversationId: string) => Promise<void>;
  send: (projectId: string, prompt: string, contextLabel?: string, consent?: boolean) => Promise<void>;
  stop: (projectId: string) => Promise<void>;
  respondApproval: (approvalId: string, decision: AIApprovalDecision) => Promise<void>;
  handleStream: (payload: AIStreamEvent) => void;
  handleRuntime: (run: AIRun) => void;
  handleProviderUpdate: (provider: AIProvider, update: Partial<AIProviderStatus>) => void;
  handleApproval: (approval: AIApprovalRequest) => void;
  clear: () => void;
}

const defaultConfig = (projectId: string): AIConfig => ({ projectId, provider: "codex", model: "", fastMode: false, consent: false });
const aiProviders: AIProvider[] = ["codex", "claude"];
const now = () => new Date().toISOString();

function sortedConversations(items: AIConversation[]): AIConversation[] {
  return [...items].sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
}

function persistedTools(messages: AIMessage[]): AIToolActivity[] {
  const tools: AIToolActivity[] = [];
  for (const message of messages) {
    const metadata = message.metadata && typeof message.metadata === "object" ? message.metadata as Record<string, unknown> : {};
    const events = Array.isArray(metadata.events) ? metadata.events : [];
    for (const raw of events) {
      if (!raw || typeof raw !== "object") continue;
      const event = raw as Record<string, unknown>;
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (!toolCallId) continue;
      if (event.type === "tool_start") {
        tools.push({ toolCallId, messageId: message.id, name: typeof event.name === "string" ? event.name : "tool", input: event.input, status: "running" });
      } else if (event.type === "tool_result") {
        const index = tools.findIndex((tool) => tool.toolCallId === toolCallId);
        const current = index >= 0 ? tools[index] : { toolCallId, messageId: message.id, name: "tool", status: "running" as const };
        const next: AIToolActivity = { ...current, output: event.output, error: typeof event.error === "string" ? event.error : undefined, status: event.error ? "error" : "complete" };
        if (index >= 0) tools[index] = next; else tools.push(next);
      }
    }
  }
  return tools;
}

export const useAIStore = create<AIState>((set, get) => ({
  configByProject: {},
  providerStatus: {},
  modelsByProvider: {},
  conversationsByProject: {},
  activeConversationByProject: {},
  messagesByConversation: {},
  toolsByConversation: {},
  runsByConversation: {},
  approvalsByConversation: {},
  loadingProjects: {},
  sendingByConversation: {},
  errorByProject: {},

  initializeProject: async (projectId) => {
    if (!projectId || get().loadingProjects[projectId]) return;
    set((state) => ({ loadingProjects: { ...state.loadingProjects, [projectId]: true }, errorByProject: { ...state.errorByProject, [projectId]: undefined } }));
    try {
      const [config, conversations] = await Promise.all([
        bridge.AIGetConfig(projectId),
        bridge.AIListConversations(projectId),
      ]);
      const provider = config.provider || "codex";
      const providerResults = await Promise.all(aiProviders.map(async (candidate) => {
        try {
          const status = await bridge.AIProviderStatus(candidate);
          const models = status.authenticated ? await bridge.AIProviderListModels(candidate).catch(() => []) : [];
          return { provider: candidate, status, models };
        } catch (error) {
          return {
            provider: candidate,
            status: { provider: candidate, available: false, authenticated: false, error: getErrorMessage(error) },
            models: [],
          };
        }
      }));
      const loadedStatuses: Partial<Record<AIProvider, AIProviderStatus>> = {};
      const loadedModels: Partial<Record<AIProvider, AIModel[]>> = {};
      for (const result of providerResults) {
        loadedStatuses[result.provider] = result.status;
        loadedModels[result.provider] = result.models;
      }
      const model = config.model || loadedModels[provider]?.[0]?.id || "";
      const active = get().activeConversationByProject[projectId];
      const conversationId = active && conversations.some((item) => item.id === active) ? active : conversations[0]?.id;
      set((state) => ({
        configByProject: { ...state.configByProject, [projectId]: { ...config, provider, model } },
        providerStatus: { ...state.providerStatus, ...loadedStatuses },
        modelsByProvider: { ...state.modelsByProvider, ...loadedModels },
        conversationsByProject: { ...state.conversationsByProject, [projectId]: sortedConversations(conversations) },
        activeConversationByProject: { ...state.activeConversationByProject, [projectId]: conversationId },
      }));
      if (conversationId) await get().selectConversation(projectId, conversationId);
    } catch (error) {
      set((state) => ({ errorByProject: { ...state.errorByProject, [projectId]: getErrorMessage(error) } }));
    } finally {
      set((state) => ({ loadingProjects: { ...state.loadingProjects, [projectId]: false } }));
    }
  },

  refreshProvider: async (provider) => {
    const [status, models] = await Promise.all([
      bridge.AIProviderStatus(provider),
      bridge.AIProviderListModels(provider).catch(() => []),
    ]);
    set((state) => ({ providerStatus: { ...state.providerStatus, [provider]: status }, modelsByProvider: { ...state.modelsByProvider, [provider]: models } }));
  },

  loginProvider: async (provider) => {
    const result = await bridge.AIProviderLogin(provider);
    if (result && typeof result === "object") {
      const value = result as Record<string, unknown>;
      const authUrl = typeof value.authUrl === "string" ? value.authUrl : typeof value.verificationUrl === "string" ? value.verificationUrl : undefined;
      if (authUrl) bridge.OpenExternalURL(authUrl);
    }
    await get().refreshProvider(provider);
  },

  logoutProvider: async (provider) => {
    await bridge.AIProviderLogout(provider);
    await get().refreshProvider(provider);
  },

  setConfig: (projectId, patch) => set((state) => {
    const current = state.configByProject[projectId] ?? defaultConfig(projectId);
    const providerChanged = patch.provider !== undefined && patch.provider !== current.provider;
    return { configByProject: { ...state.configByProject, [projectId]: { ...current, ...patch, ...(providerChanged ? { consent: false } : {}) } } };
  }),

  createConversation: async (projectId, title) => {
    const config = get().configByProject[projectId] ?? defaultConfig(projectId);
    if (!config.model) throw new Error("Choose an AI model before starting a conversation.");
    const conversation = await bridge.AICreateConversation({ projectId, title, provider: config.provider, model: config.model });
    set((state) => ({
      conversationsByProject: { ...state.conversationsByProject, [projectId]: sortedConversations([conversation, ...(state.conversationsByProject[projectId] ?? []).filter((item) => item.id !== conversation.id)]) },
      activeConversationByProject: { ...state.activeConversationByProject, [projectId]: conversation.id },
      messagesByConversation: { ...state.messagesByConversation, [conversation.id]: [] },
      toolsByConversation: { ...state.toolsByConversation, [conversation.id]: [] },
    }));
    return conversation;
  },

  selectConversation: async (projectId, conversationId) => {
    set((state) => ({ activeConversationByProject: { ...state.activeConversationByProject, [projectId]: conversationId } }));
    const detail = await bridge.AIGetConversation({ projectId, conversationId });
    set((state) => ({
      messagesByConversation: { ...state.messagesByConversation, [conversationId]: detail.messages },
      toolsByConversation: { ...state.toolsByConversation, [conversationId]: persistedTools(detail.messages) },
      conversationsByProject: {
        ...state.conversationsByProject,
        [projectId]: (state.conversationsByProject[projectId] ?? []).map((item) => item.id === conversationId ? detail.conversation : item),
      },
    }));
  },

  deleteConversation: async (projectId, conversationId) => {
    await bridge.AIDeleteConversation({ projectId, conversationId });
    const remaining = (get().conversationsByProject[projectId] ?? []).filter((item) => item.id !== conversationId);
    set((state) => {
      const messages = { ...state.messagesByConversation }; delete messages[conversationId];
      const tools = { ...state.toolsByConversation }; delete tools[conversationId];
      return {
        conversationsByProject: { ...state.conversationsByProject, [projectId]: remaining },
        activeConversationByProject: { ...state.activeConversationByProject, [projectId]: remaining[0]?.id },
        messagesByConversation: messages,
        toolsByConversation: tools,
      };
    });
    if (remaining[0]) await get().selectConversation(projectId, remaining[0].id);
  },

  send: async (projectId, prompt, contextLabel, consent = false) => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) return;
    let conversationId = get().activeConversationByProject[projectId];
    if (!conversationId) conversationId = (await get().createConversation(projectId, cleanPrompt.slice(0, 80))).id;
    const config = get().configByProject[projectId] ?? defaultConfig(projectId);
    const localUser: AIMessage = {
      id: `local:${crypto.randomUUID()}`, conversationId, sequence: Date.now(), role: "user", content: cleanPrompt,
      status: "complete", createdAt: now(), updatedAt: now(),
    };
    set((state) => ({
      messagesByConversation: { ...state.messagesByConversation, [conversationId!]: [...(state.messagesByConversation[conversationId!] ?? []), localUser] },
      sendingByConversation: { ...state.sendingByConversation, [conversationId!]: true },
      errorByProject: { ...state.errorByProject, [projectId]: undefined },
    }));
    try {
      const run = await bridge.AISend({ projectId, conversationId, prompt: cleanPrompt, provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort, fastMode: config.fastMode, contextLabel, consent });
      const assistant: AIMessage = {
        id: run.assistantMessageId, conversationId, sequence: Date.now() + 1, role: "assistant", content: "", status: "streaming", createdAt: now(), updatedAt: now(),
      };
      set((state) => ({
        configByProject: consent ? { ...state.configByProject, [projectId]: { ...config, consent: true } } : state.configByProject,
        runsByConversation: { ...state.runsByConversation, [conversationId!]: run },
        messagesByConversation: {
          ...state.messagesByConversation,
          [conversationId!]: (state.messagesByConversation[conversationId!] ?? []).some((message) => message.id === assistant.id)
            ? state.messagesByConversation[conversationId!] : [...(state.messagesByConversation[conversationId!] ?? []), assistant],
        },
      }));
    } catch (error) {
      set((state) => ({
        sendingByConversation: { ...state.sendingByConversation, [conversationId!]: false },
        errorByProject: { ...state.errorByProject, [projectId]: getErrorMessage(error) },
      }));
      throw error;
    }
  },

  stop: async (projectId) => {
    const conversationId = get().activeConversationByProject[projectId];
    if (!conversationId) return;
    const run = get().runsByConversation[conversationId];
    await bridge.AIStop({ projectId, conversationId, runId: run?.id });
  },

  respondApproval: async (approvalId, decision) => {
    await bridge.AIRespondApproval({ approvalId, decision });
    set((state) => ({ approvalsByConversation: Object.fromEntries(Object.entries(state.approvalsByConversation).map(([id, approvals]) => [id, approvals.filter((item) => item.id !== approvalId)])) }));
  },

  handleStream: (payload) => set((state) => {
    const messages = [...(state.messagesByConversation[payload.conversationId] ?? [])];
    let index = messages.findIndex((message) => message.id === payload.messageId);
    if (index < 0) {
      messages.push({ id: payload.messageId, conversationId: payload.conversationId, sequence: Date.now(), role: "assistant", content: "", status: "streaming", createdAt: now(), updatedAt: now() });
      index = messages.length - 1;
    }
    const message = messages[index];
    const event = payload.event;
    if (event.type === "text_delta") messages[index] = { ...message, content: message.content + (event.text ?? ""), updatedAt: now() };
    if (event.type === "reasoning_delta") messages[index] = { ...message, reasoning: (message.reasoning ?? "") + (event.text ?? ""), updatedAt: now() };
    if (["completed", "cancelled", "error"].includes(event.type)) messages[index] = { ...messages[index], status: event.type === "completed" ? "complete" : event.type, error: event.error, updatedAt: now() } as AIMessage;

    let tools = [...(state.toolsByConversation[payload.conversationId] ?? [])];
    if (event.type === "tool_start" && event.toolCallId) {
      tools = [...tools.filter((tool) => tool.toolCallId !== event.toolCallId), { toolCallId: event.toolCallId, messageId: payload.messageId, name: event.name ?? "tool", input: event.input, status: "running" }];
    } else if (event.type === "tool_result" && event.toolCallId) {
      const toolIndex = tools.findIndex((tool) => tool.toolCallId === event.toolCallId);
      const update: AIToolActivity = { ...(toolIndex >= 0 ? tools[toolIndex] : { toolCallId: event.toolCallId, messageId: payload.messageId, name: "tool" }), output: event.output, error: event.error, status: event.error ? "error" : "complete" };
      if (toolIndex >= 0) tools[toolIndex] = update; else tools.push(update);
    }
    return { messagesByConversation: { ...state.messagesByConversation, [payload.conversationId]: messages }, toolsByConversation: { ...state.toolsByConversation, [payload.conversationId]: tools } };
  }),

  handleRuntime: (run) => set((state) => {
    const running = run.state === "running";
    return {
      runsByConversation: { ...state.runsByConversation, [run.conversationId]: running ? run : undefined },
      sendingByConversation: { ...state.sendingByConversation, [run.conversationId]: running },
    };
  }),

  handleProviderUpdate: (provider, update) => set((state) => ({
    providerStatus: { ...state.providerStatus, [provider]: { provider, available: false, authenticated: false, ...state.providerStatus[provider], ...update } },
  })),

  handleApproval: (approval) => set((state) => ({
    approvalsByConversation: { ...state.approvalsByConversation, [approval.conversationId]: [...(state.approvalsByConversation[approval.conversationId] ?? []).filter((item) => item.id !== approval.id), approval] },
  })),

  clear: () => set({ configByProject: {}, providerStatus: {}, modelsByProvider: {}, conversationsByProject: {}, activeConversationByProject: {}, messagesByConversation: {}, toolsByConversation: {}, runsByConversation: {}, approvalsByConversation: {}, loadingProjects: {}, sendingByConversation: {}, errorByProject: {} }),
}));
