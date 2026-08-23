package ai

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"ducs-table/internal/database"
	"ducs-table/internal/models"
)

// Store is intentionally interface-based so runtime tests can use an in-memory
// fake without starting DuckDB or the sidecar process.
type Store interface {
	GetConfig(context.Context, string) (Config, error)
	SaveConfig(context.Context, Config) error
	ListConversations(context.Context, string) ([]Conversation, error)
	CreateConversation(context.Context, Conversation) error
	GetConversation(context.Context, string, string) (ConversationDetail, error)
	DeleteConversation(context.Context, string, string) error
	CreateMessage(context.Context, Message) (Message, error)
	AppendMessage(context.Context, string, string, string) error
	AppendEvent(context.Context, string, ChatEvent) error
	FinishMessage(context.Context, string, MessageStatus, string) error
	ProviderSession(context.Context, SessionBinding) (string, error)
	AnyProviderSession(context.Context, string, Provider) (string, error)
	SaveProviderSession(context.Context, SessionBinding) error
	ProviderSessions(context.Context, Provider) ([]string, error)
	DeleteProviderSessions(context.Context, Provider) error
}

type Repository struct{ db *database.DB }

func NewRepository(db *database.DB) *Repository { return &Repository{db: db} }

func (r *Repository) GetConfig(ctx context.Context, projectID string) (Config, error) {
	if err := requireProjectID(projectID); err != nil {
		return Config{}, err
	}
	config := Config{ProjectID: projectID, Provider: ProviderCodex}
	err := r.db.SQL().QueryRowContext(ctx, `
		SELECT provider, model, reasoning_effort, consent, fast_mode
		FROM ducs_meta.ai_settings WHERE project_id = ?`, projectID).Scan(&config.Provider, &config.Model, &config.ReasoningEffort, &config.Consent, &config.FastMode)
	if errors.Is(err, sql.ErrNoRows) {
		var exists bool
		if queryErr := r.db.SQL().QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM ducs_meta.projects WHERE id = ? AND archived_at IS NULL)`, projectID).Scan(&exists); queryErr != nil {
			return Config{}, databaseError("Could not read AI settings", queryErr, projectID)
		}
		if !exists {
			return Config{}, models.NewError(models.CodeProjectNotFound, "Project was not found", map[string]any{"projectId": projectID})
		}
		return config, nil
	}
	if err != nil {
		return Config{}, databaseError("Could not read AI settings", err, projectID)
	}
	return config, nil
}

func (r *Repository) SaveConfig(ctx context.Context, config Config) error {
	if err := validateConfig(config); err != nil {
		return err
	}
	_, err := r.db.SQL().ExecContext(ctx, `
		INSERT INTO ducs_meta.ai_settings (project_id, provider, model, reasoning_effort, consent, fast_mode, updated_at)
		SELECT id, ?, ?, ?, ?, ?, ? FROM ducs_meta.projects WHERE id = ? AND archived_at IS NULL
		ON CONFLICT (project_id) DO UPDATE SET provider = excluded.provider,
			model = excluded.model, reasoning_effort = excluded.reasoning_effort,
			consent = excluded.consent, fast_mode = excluded.fast_mode,
			updated_at = excluded.updated_at`, config.Provider, config.Model, config.ReasoningEffort, config.Consent, config.FastMode, time.Now().UTC(), config.ProjectID)
	if err != nil {
		return databaseError("Could not save AI settings", err, config.ProjectID)
	}
	return nil
}

func (r *Repository) ListConversations(ctx context.Context, projectID string) ([]Conversation, error) {
	if err := requireProjectID(projectID); err != nil {
		return nil, err
	}
	rows, err := r.db.SQL().QueryContext(ctx, conversationSelect+` WHERE project_id = ? ORDER BY updated_at DESC, id`, projectID)
	if err != nil {
		return nil, databaseError("Could not list AI conversations", err, projectID)
	}
	defer rows.Close()
	items := make([]Conversation, 0)
	for rows.Next() {
		item, scanErr := scanConversation(rows)
		if scanErr != nil {
			return nil, databaseError("Could not read AI conversation", scanErr, projectID)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, databaseError("Could not list AI conversations", err, projectID)
	}
	return items, nil
}

func (r *Repository) CreateConversation(ctx context.Context, conversation Conversation) error {
	conversation.Title = strings.TrimSpace(conversation.Title)
	conversation.Model = strings.TrimSpace(conversation.Model)
	if conversation.ID == "" || conversation.ProjectID == "" || conversation.Title == "" || len([]rune(conversation.Title)) > 200 || !conversation.Provider.Valid() || conversation.Model == "" {
		return models.NewError(models.CodeInvalidArgument, "AI conversation metadata is invalid", nil)
	}
	if conversation.CreatedAt.IsZero() {
		conversation.CreatedAt = time.Now().UTC()
	}
	if conversation.UpdatedAt.IsZero() {
		conversation.UpdatedAt = conversation.CreatedAt
	}
	result, err := r.db.SQL().ExecContext(ctx, `
		INSERT INTO ducs_meta.ai_conversations (id, project_id, title, provider, model, created_at, updated_at)
		SELECT ?, id, ?, ?, ?, ?, ? FROM ducs_meta.projects WHERE id = ? AND archived_at IS NULL`,
		conversation.ID, conversation.Title, conversation.Provider, conversation.Model,
		conversation.CreatedAt, conversation.UpdatedAt, conversation.ProjectID)
	if err != nil {
		return databaseError("Could not create AI conversation", err, conversation.ProjectID)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return models.NewError(models.CodeProjectNotFound, "Project was not found", map[string]any{"projectId": conversation.ProjectID})
	}
	return nil
}

func (r *Repository) GetConversation(ctx context.Context, projectID, conversationID string) (ConversationDetail, error) {
	if err := requireConversationIDs(projectID, conversationID); err != nil {
		return ConversationDetail{}, err
	}
	conversation, err := scanConversation(r.db.SQL().QueryRowContext(ctx, conversationSelect+` WHERE project_id = ? AND id = ?`, projectID, conversationID))
	if errors.Is(err, sql.ErrNoRows) {
		return ConversationDetail{}, conversationNotFound(conversationID)
	}
	if err != nil {
		return ConversationDetail{}, databaseError("Could not read AI conversation", err, projectID)
	}
	rows, err := r.db.SQL().QueryContext(ctx, messageSelect+` WHERE conversation_id = ? ORDER BY sequence`, conversationID)
	if err != nil {
		return ConversationDetail{}, databaseError("Could not list AI messages", err, projectID)
	}
	defer rows.Close()
	messages := make([]Message, 0)
	for rows.Next() {
		message, scanErr := scanMessage(rows)
		if scanErr != nil {
			return ConversationDetail{}, databaseError("Could not read AI message", scanErr, projectID)
		}
		messages = append(messages, message)
	}
	if err := rows.Err(); err != nil {
		return ConversationDetail{}, databaseError("Could not list AI messages", err, projectID)
	}
	return ConversationDetail{Conversation: conversation, Messages: messages}, nil
}

func (r *Repository) DeleteConversation(ctx context.Context, projectID, conversationID string) error {
	if err := requireConversationIDs(projectID, conversationID); err != nil {
		return err
	}
	return r.db.WithTx(ctx, func(tx *sql.Tx) error {
		var exists bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM ducs_meta.ai_conversations WHERE project_id = ? AND id = ?)`, projectID, conversationID).Scan(&exists); err != nil {
			return databaseError("Could not inspect AI conversation", err, projectID)
		}
		if !exists {
			return conversationNotFound(conversationID)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM ducs_meta.ai_provider_sessions WHERE conversation_id = ?`, conversationID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM ducs_meta.ai_messages WHERE conversation_id = ?`, conversationID); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM ducs_meta.ai_conversations WHERE project_id = ? AND id = ?`, projectID, conversationID)
		return err
	})
}

func (r *Repository) CreateMessage(ctx context.Context, message Message) (Message, error) {
	if message.ID == "" || message.ConversationID == "" || (message.Role != "user" && message.Role != "assistant" && message.Role != "tool" && message.Role != "system") {
		return Message{}, models.NewError(models.CodeInvalidArgument, "AI message metadata is invalid", nil)
	}
	if message.Status == "" {
		message.Status = MessageComplete
	}
	if len(message.Metadata) == 0 {
		message.Metadata = json.RawMessage(`{}`)
	}
	if !json.Valid(message.Metadata) {
		return Message{}, models.NewError(models.CodeInvalidArgument, "AI message metadata must be valid JSON", nil)
	}
	now := time.Now().UTC()
	message.CreatedAt, message.UpdatedAt = now, now
	err := r.db.WithTx(ctx, func(tx *sql.Tx) error {
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(sequence), 0) + 1 FROM ducs_meta.ai_messages WHERE conversation_id = ?`, message.ConversationID).Scan(&message.Sequence); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `
			INSERT INTO ducs_meta.ai_messages (id, conversation_id, sequence, role, content, reasoning, status, error, metadata_json, created_at, updated_at)
			SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM ducs_meta.ai_conversations WHERE id = ?`,
			message.ID, message.Sequence, message.Role, message.Content, message.Reasoning,
			message.Status, message.Error, string(message.Metadata), now, now, message.ConversationID)
		if err != nil {
			return err
		}
		if affected, _ := result.RowsAffected(); affected == 0 {
			return conversationNotFound(message.ConversationID)
		}
		_, err = tx.ExecContext(ctx, `UPDATE ducs_meta.ai_conversations SET updated_at = ? WHERE id = ?`, now, message.ConversationID)
		return err
	})
	if err != nil {
		var appErr *models.AppError
		if errors.As(err, &appErr) {
			return Message{}, appErr
		}
		return Message{}, databaseError("Could not save AI message", err, "")
	}
	return message, nil
}

func (r *Repository) AppendMessage(ctx context.Context, messageID, content, reasoning string) error {
	if messageID == "" {
		return models.NewError(models.CodeInvalidArgument, "AI message ID is required", nil)
	}
	_, err := r.db.SQL().ExecContext(ctx, `
		UPDATE ducs_meta.ai_messages SET content = content || ?, reasoning = reasoning || ?, updated_at = ?
		WHERE id = ? AND status = 'streaming'`, content, reasoning, time.Now().UTC(), messageID)
	if err != nil {
		return databaseError("Could not append AI message", err, "")
	}
	return nil
}

func (r *Repository) AppendEvent(ctx context.Context, messageID string, event ChatEvent) error {
	if messageID == "" {
		return models.NewError(models.CodeInvalidArgument, "AI message ID is required", nil)
	}
	var raw string
	if err := r.db.SQL().QueryRowContext(ctx, `SELECT metadata_json FROM ducs_meta.ai_messages WHERE id = ?`, messageID).Scan(&raw); err != nil {
		return databaseError("Could not read AI message metadata", err, "")
	}
	metadata := struct {
		Events []ChatEvent `json:"events"`
	}{Events: make([]ChatEvent, 0)}
	_ = json.Unmarshal([]byte(raw), &metadata)
	metadata.Events = append(metadata.Events, event)
	if len(metadata.Events) > 200 {
		metadata.Events = metadata.Events[len(metadata.Events)-200:]
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return databaseError("Could not encode AI message metadata", err, "")
	}
	_, err = r.db.SQL().ExecContext(ctx, `UPDATE ducs_meta.ai_messages SET metadata_json = ?, updated_at = ? WHERE id = ?`, string(encoded), time.Now().UTC(), messageID)
	if err != nil {
		return databaseError("Could not save AI message metadata", err, "")
	}
	return nil
}

func (r *Repository) FinishMessage(ctx context.Context, messageID string, status MessageStatus, messageError string) error {
	if status != MessageComplete && status != MessageInterrupted && status != MessageCancelled && status != MessageError {
		return models.NewError(models.CodeInvalidArgument, "AI message status is invalid", nil)
	}
	_, err := r.db.SQL().ExecContext(ctx, `UPDATE ducs_meta.ai_messages SET status = ?, error = ?, updated_at = ? WHERE id = ?`, status, RedactString(messageError), time.Now().UTC(), messageID)
	if err != nil {
		return databaseError("Could not finish AI message", err, "")
	}
	return nil
}

func (r *Repository) ProviderSession(ctx context.Context, binding SessionBinding) (string, error) {
	var sessionID string
	err := r.db.SQL().QueryRowContext(ctx, `SELECT session_id FROM ducs_meta.ai_provider_sessions
		WHERE conversation_id = ? AND provider = ? AND model = ? AND tool_signature = ? AND context_hash = ? AND account_fingerprint = ?`,
		binding.ConversationID, binding.Provider, binding.Model, binding.ToolSignature, binding.ContextHash, binding.AccountFingerprint).Scan(&sessionID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", databaseError("Could not read AI provider session", err, "")
	}
	return sessionID, nil
}

func (r *Repository) AnyProviderSession(ctx context.Context, conversationID string, provider Provider) (string, error) {
	var sessionID string
	err := r.db.SQL().QueryRowContext(ctx, `SELECT session_id FROM ducs_meta.ai_provider_sessions WHERE conversation_id = ? AND provider = ?`, conversationID, provider).Scan(&sessionID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", databaseError("Could not read AI provider session", err, "")
	}
	return sessionID, nil
}

func (r *Repository) SaveProviderSession(ctx context.Context, binding SessionBinding) error {
	if binding.ConversationID == "" || !binding.Provider.Valid() || strings.TrimSpace(binding.SessionID) == "" || binding.Model == "" || binding.ToolSignature == "" || binding.ContextHash == "" || binding.AccountFingerprint == "" {
		return models.NewError(models.CodeInvalidArgument, "AI provider session is invalid", nil)
	}
	now := time.Now().UTC()
	_, err := r.db.SQL().ExecContext(ctx, `
		INSERT INTO ducs_meta.ai_provider_sessions (conversation_id, provider, session_id, model, tool_signature, context_hash, account_fingerprint, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (conversation_id, provider) DO UPDATE
		SET session_id = excluded.session_id, model = excluded.model, tool_signature = excluded.tool_signature,
			context_hash = excluded.context_hash, account_fingerprint = excluded.account_fingerprint,
			updated_at = excluded.updated_at`, binding.ConversationID, binding.Provider, binding.SessionID, binding.Model, binding.ToolSignature, binding.ContextHash, binding.AccountFingerprint, now, now)
	if err != nil {
		return databaseError("Could not save AI provider session", err, "")
	}
	return nil
}

func (r *Repository) ProviderSessions(ctx context.Context, provider Provider) ([]string, error) {
	rows, err := r.db.SQL().QueryContext(ctx, `SELECT session_id FROM ducs_meta.ai_provider_sessions WHERE provider = ?`, provider)
	if err != nil {
		return nil, databaseError("Could not list AI provider sessions", err, "")
	}
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		result = append(result, id)
	}
	return result, rows.Err()
}

func (r *Repository) DeleteProviderSessions(ctx context.Context, provider Provider) error {
	_, err := r.db.SQL().ExecContext(ctx, `DELETE FROM ducs_meta.ai_provider_sessions WHERE provider = ?`, provider)
	if err != nil {
		return databaseError("Could not invalidate AI provider sessions", err, "")
	}
	return nil
}

const conversationSelect = `SELECT id, project_id, title, provider, model, created_at, updated_at FROM ducs_meta.ai_conversations`
const messageSelect = `SELECT id, conversation_id, sequence, role, content, reasoning, status, error, metadata_json, created_at, updated_at FROM ducs_meta.ai_messages`

type scanner interface{ Scan(...any) error }

func scanConversation(row scanner) (Conversation, error) {
	var item Conversation
	err := row.Scan(&item.ID, &item.ProjectID, &item.Title, &item.Provider, &item.Model, &item.CreatedAt, &item.UpdatedAt)
	return item, err
}

func scanMessage(row scanner) (Message, error) {
	var item Message
	var metadata string
	err := row.Scan(&item.ID, &item.ConversationID, &item.Sequence, &item.Role, &item.Content, &item.Reasoning, &item.Status, &item.Error, &metadata, &item.CreatedAt, &item.UpdatedAt)
	item.Metadata = json.RawMessage(metadata)
	return item, err
}

func requireProjectID(projectID string) error {
	if strings.TrimSpace(projectID) == "" {
		return models.NewError(models.CodeInvalidArgument, "Project ID is required", nil)
	}
	return nil
}

func requireConversationIDs(projectID, conversationID string) error {
	if err := requireProjectID(projectID); err != nil {
		return err
	}
	if strings.TrimSpace(conversationID) == "" {
		return models.NewError(models.CodeInvalidArgument, "Conversation ID is required", nil)
	}
	return nil
}

func validateConfig(config Config) error {
	if err := requireProjectID(config.ProjectID); err != nil {
		return err
	}
	if !config.Provider.Valid() || strings.TrimSpace(config.Model) == "" {
		return models.NewError(models.CodeInvalidArgument, "AI provider and model are required", nil)
	}
	return nil
}

func conversationNotFound(id string) error {
	return models.NewError(models.CodeNotFound, "AI conversation was not found", map[string]any{"conversationId": id})
}

func databaseError(message string, err error, projectID string) error {
	details := map[string]any{}
	if projectID != "" {
		details["projectId"] = projectID
	}
	return models.WrapError(models.CodeDatabase, message, err, details)
}
