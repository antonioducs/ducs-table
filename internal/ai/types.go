// Package ai owns the host side of AI conversations. Provider processes never
// receive database credentials and can access project data only through the
// bounded tools declared here.
package ai

import (
	"encoding/json"
	"time"
)

type Provider string

const (
	ProviderCodex  Provider = "codex"
	ProviderClaude Provider = "claude"
)

func (p Provider) Valid() bool { return p == ProviderCodex || p == ProviderClaude }

type MessageStatus string

const (
	MessageComplete    MessageStatus = "complete"
	MessageStreaming   MessageStatus = "streaming"
	MessageInterrupted MessageStatus = "interrupted"
	MessageCancelled   MessageStatus = "cancelled"
	MessageError       MessageStatus = "error"
)

type Config struct {
	ProjectID       string   `json:"projectId"`
	Provider        Provider `json:"provider"`
	Model           string   `json:"model"`
	ReasoningEffort string   `json:"reasoningEffort,omitempty"`
	FastMode        bool     `json:"fastMode"`
	Consent         bool     `json:"consent"`
}

type ProviderStatus struct {
	Provider      Provider `json:"provider"`
	Available     bool     `json:"available"`
	Authenticated bool     `json:"authenticated"`
	Account       any      `json:"account,omitempty"`
	Version       string   `json:"version,omitempty"`
	Error         string   `json:"error,omitempty"`
}

type Model struct {
	ID          string `json:"id"`
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
	Raw         any    `json:"raw,omitempty"`
}

type SessionBinding struct {
	ConversationID     string
	Provider           Provider
	SessionID          string
	Model              string
	ToolSignature      string
	ContextHash        string
	AccountFingerprint string
}

type Conversation struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"projectId"`
	Title     string    `json:"title"`
	Provider  Provider  `json:"provider"`
	Model     string    `json:"model"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type Message struct {
	ID             string          `json:"id"`
	ConversationID string          `json:"conversationId"`
	Sequence       int64           `json:"sequence"`
	Role           string          `json:"role"`
	Content        string          `json:"content"`
	Reasoning      string          `json:"reasoning,omitempty"`
	Status         MessageStatus   `json:"status"`
	Error          string          `json:"error,omitempty"`
	Metadata       json.RawMessage `json:"metadata,omitempty"`
	CreatedAt      time.Time       `json:"createdAt"`
	UpdatedAt      time.Time       `json:"updatedAt"`
}

type ConversationDetail struct {
	Conversation Conversation `json:"conversation"`
	Messages     []Message    `json:"messages"`
}

type CreateConversationRequest struct {
	ProjectID string   `json:"projectId"`
	Title     string   `json:"title,omitempty"`
	Provider  Provider `json:"provider"`
	Model     string   `json:"model"`
}

type ConversationRequest struct {
	ProjectID      string `json:"projectId"`
	ConversationID string `json:"conversationId"`
}

type SendRequest struct {
	ProjectID       string   `json:"projectId"`
	ConversationID  string   `json:"conversationId"`
	Prompt          string   `json:"prompt"`
	Provider        Provider `json:"provider,omitempty"`
	Model           string   `json:"model,omitempty"`
	ReasoningEffort string   `json:"reasoningEffort,omitempty"`
	FastMode        bool     `json:"fastMode,omitempty"`
	ContextLabel    string   `json:"contextLabel,omitempty"`
	Consent         bool     `json:"consent,omitempty"`
}

type StopRequest struct {
	ProjectID      string `json:"projectId"`
	ConversationID string `json:"conversationId,omitempty"`
	RunID          string `json:"runId,omitempty"`
}

type ApprovalResponse struct {
	ApprovalID string           `json:"approvalId"`
	Decision   ApprovalDecision `json:"decision"`
}

type ApprovalDecision string

const (
	ApprovalDeny              ApprovalDecision = "deny"
	ApprovalAllowOnce         ApprovalDecision = "allow_once"
	ApprovalAllowConversation ApprovalDecision = "allow_conversation"
)

func (d ApprovalDecision) Valid() bool {
	return d == ApprovalDeny || d == ApprovalAllowOnce || d == ApprovalAllowConversation
}

type Run struct {
	ID                 string     `json:"id"`
	ProjectID          string     `json:"projectId"`
	ConversationID     string     `json:"conversationId"`
	ChatID             string     `json:"chatId"`
	Provider           Provider   `json:"provider"`
	AssistantMessageID string     `json:"assistantMessageId"`
	State              string     `json:"state"`
	Error              string     `json:"error,omitempty"`
	StartedAt          time.Time  `json:"startedAt"`
	FinishedAt         *time.Time `json:"finishedAt,omitempty"`
}

type ApprovalRequest struct {
	ID             string    `json:"id"`
	ProjectID      string    `json:"projectId"`
	ConversationID string    `json:"conversationId"`
	RunID          string    `json:"runId"`
	ToolCallID     string    `json:"toolCallId"`
	Tool           string    `json:"tool"`
	Summary        string    `json:"summary"`
	Input          any       `json:"input"`
	CreatedAt      time.Time `json:"createdAt"`
}

type ToolSpec struct {
	Name         string         `json:"name"`
	Description  string         `json:"description"`
	InputSchema  map[string]any `json:"inputSchema"`
	DeferLoading bool           `json:"deferLoading,omitempty"`
}

type ChatEvent struct {
	Type             string  `json:"type"`
	SessionID        string  `json:"sessionId,omitempty"`
	Text             string  `json:"text,omitempty"`
	PartID           string  `json:"partId,omitempty"`
	ToolCallID       string  `json:"toolCallId,omitempty"`
	Name             string  `json:"name,omitempty"`
	Input            any     `json:"input,omitempty"`
	Output           any     `json:"output,omitempty"`
	Error            string  `json:"error,omitempty"`
	Code             string  `json:"code,omitempty"`
	InputTokens      int64   `json:"inputTokens,omitempty"`
	OutputTokens     int64   `json:"outputTokens,omitempty"`
	CacheReadTokens  int64   `json:"cacheReadTokens,omitempty"`
	CacheWriteTokens int64   `json:"cacheWriteTokens,omitempty"`
	CostUSD          float64 `json:"costUsd,omitempty"`
}

type StreamEvent struct {
	RunID          string    `json:"runId"`
	ProjectID      string    `json:"projectId"`
	ConversationID string    `json:"conversationId"`
	MessageID      string    `json:"messageId"`
	ChatID         string    `json:"chatId"`
	Provider       Provider  `json:"provider"`
	Event          ChatEvent `json:"event"`
}
