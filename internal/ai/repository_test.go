package ai

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"ducs-table/internal/database"
	"ducs-table/internal/models"
)

func TestRepositoryPersistsProjectScopedConversationAndStream(t *testing.T) {
	ctx := context.Background()
	db, err := database.OpenPath(ctx, filepath.Join(t.TempDir(), "repository.duckdb"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var projectID string
	if err := db.SQL().QueryRowContext(ctx, `SELECT id FROM ducs_meta.projects LIMIT 1`).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	repository := NewRepository(db)
	config, err := repository.GetConfig(ctx, projectID)
	if err != nil || config.Provider != ProviderCodex || config.Consent {
		t.Fatalf("default config=%#v err=%v", config, err)
	}
	config.Provider, config.Model, config.Consent, config.FastMode = ProviderClaude, "test-model", true, true
	if err := repository.SaveConfig(ctx, config); err != nil {
		t.Fatal(err)
	}
	storedConfig, err := repository.GetConfig(ctx, projectID)
	if err != nil || !storedConfig.Consent || !storedConfig.FastMode {
		t.Fatalf("stored config=%#v err=%v", storedConfig, err)
	}
	conversationID, _ := models.NewID()
	now := time.Now().UTC()
	conversation := Conversation{ID: conversationID, ProjectID: projectID, Title: "Test", Provider: ProviderClaude, Model: "test-model", CreatedAt: now, UpdatedAt: now}
	if err := repository.CreateConversation(ctx, conversation); err != nil {
		t.Fatal(err)
	}
	messageID, _ := models.NewID()
	message, err := repository.CreateMessage(ctx, Message{ID: messageID, ConversationID: conversationID, Role: "assistant", Status: MessageStreaming})
	if err != nil {
		t.Fatal(err)
	}
	if err := repository.AppendMessage(ctx, message.ID, "answer", "thought"); err != nil {
		t.Fatal(err)
	}
	if err := repository.AppendEvent(ctx, message.ID, ChatEvent{Type: "tool_start", ToolCallID: "tool-1", Name: "propose_sql", Input: map[string]any{"sql": "SELECT 1"}}); err != nil {
		t.Fatal(err)
	}
	if err := repository.AppendEvent(ctx, message.ID, ChatEvent{Type: "tool_result", ToolCallID: "tool-1", Output: map[string]any{"sql": "SELECT 1"}}); err != nil {
		t.Fatal(err)
	}
	if err := repository.FinishMessage(ctx, message.ID, MessageComplete, ""); err != nil {
		t.Fatal(err)
	}
	binding := SessionBinding{ConversationID: conversationID, Provider: ProviderClaude, SessionID: "session-1", Model: "test-model", ToolSignature: "tools", ContextHash: "context", AccountFingerprint: "account"}
	if err := repository.SaveProviderSession(ctx, binding); err != nil {
		t.Fatal(err)
	}
	detail, err := repository.GetConversation(ctx, projectID, conversationID)
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Messages) != 1 || detail.Messages[0].Content != "answer" || detail.Messages[0].Reasoning != "thought" || detail.Messages[0].Status != MessageComplete {
		t.Fatalf("unexpected transcript: %#v", detail.Messages)
	}
	var metadata struct {
		Events []ChatEvent `json:"events"`
	}
	if err := json.Unmarshal(detail.Messages[0].Metadata, &metadata); err != nil || len(metadata.Events) != 2 || metadata.Events[1].Type != "tool_result" {
		t.Fatalf("metadata=%s err=%v", detail.Messages[0].Metadata, err)
	}
	if session, err := repository.ProviderSession(ctx, binding); err != nil || session != "session-1" {
		t.Fatalf("session=%q err=%v", session, err)
	}
}
