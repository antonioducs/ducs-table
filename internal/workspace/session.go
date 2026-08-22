package workspace

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"ducs-table/internal/models"
)

const maxQueryHistoryEntries = 20

func emptySession() models.ProjectSession {
	return models.ProjectSession{
		Version: models.ProjectSessionVersion,
		Tabs:    make([]models.ProjectTabReference, 0),
		History: make([]models.QueryHistoryEntry, 0),
	}
}

func (s *Service) LoadSession(ctx context.Context, projectID string) (models.ProjectSession, error) {
	var session models.ProjectSession
	err := s.db.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireProject(ctx, tx, projectID, false); err != nil {
			return err
		}
		var stateJSON string
		err := tx.QueryRowContext(ctx, `SELECT state_json FROM ducs_meta.project_sessions WHERE project_id = ?`, projectID).Scan(&stateJSON)
		if errors.Is(err, sql.ErrNoRows) {
			session = emptySession()
			encoded, encodeErr := encodeSession(session)
			if encodeErr != nil {
				return encodeErr
			}
			_, err = tx.ExecContext(ctx, `INSERT INTO ducs_meta.project_sessions (project_id, state_json, updated_at) VALUES (?, ?, ?)`, projectID, encoded, time.Now().UTC())
			return err
		}
		if err != nil {
			return err
		}
		session, err = decodeSession(stateJSON)
		if err != nil {
			return models.WrapError(models.CodeDatabase, "Stored project session is invalid", err, map[string]any{"projectId": projectID})
		}
		changed, err := reconcileSession(ctx, tx, projectID, &session)
		if err != nil {
			return err
		}
		if changed {
			encoded, err := encodeSession(session)
			if err != nil {
				return err
			}
			_, err = tx.ExecContext(ctx, `UPDATE ducs_meta.project_sessions SET state_json = ?, updated_at = ? WHERE project_id = ?`, encoded, time.Now().UTC(), projectID)
			return err
		}
		return nil
	})
	if err != nil {
		var appErr *models.AppError
		if errors.As(err, &appErr) {
			return models.ProjectSession{}, appErr
		}
		return models.ProjectSession{}, models.WrapError(models.CodeDatabase, "Could not load project session", err, map[string]any{"projectId": projectID})
	}
	return session, nil
}

func (s *Service) LoadProjectSession(ctx context.Context, projectID string) (models.ProjectSession, error) {
	return s.LoadSession(ctx, projectID)
}

func (s *Service) SaveSession(ctx context.Context, projectID string, session models.ProjectSession) error {
	if len(session.History) > maxQueryHistoryEntries {
		session.History = append([]models.QueryHistoryEntry(nil), session.History[:maxQueryHistoryEntries]...)
	}
	normalizeSessionSlices(&session)
	if err := validateSession(session); err != nil {
		return err
	}
	err := s.db.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireProject(ctx, tx, projectID, false); err != nil {
			return err
		}
		if _, err := reconcileSession(ctx, tx, projectID, &session); err != nil {
			return err
		}
		encoded, err := encodeSession(session)
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		_, err = tx.ExecContext(ctx, `
			INSERT INTO ducs_meta.project_sessions (project_id, state_json, updated_at) VALUES (?, ?, ?)
			ON CONFLICT (project_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`, projectID, encoded, now)
		return err
	})
	if err != nil {
		var appErr *models.AppError
		if errors.As(err, &appErr) {
			return appErr
		}
		return models.WrapError(models.CodeDatabase, "Could not save project session", err, map[string]any{"projectId": projectID})
	}
	return nil
}

func (s *Service) SaveProjectSession(ctx context.Context, projectID string, session models.ProjectSession) error {
	return s.SaveSession(ctx, projectID, session)
}

func decodeSession(value string) (models.ProjectSession, error) {
	var session models.ProjectSession
	decoder := json.NewDecoder(bytes.NewBufferString(value))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&session); err != nil {
		return models.ProjectSession{}, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return models.ProjectSession{}, errors.New("multiple JSON values")
		}
		return models.ProjectSession{}, err
	}
	normalizeSessionSlices(&session)
	if err := validateSession(session); err != nil {
		return models.ProjectSession{}, err
	}
	return session, nil
}

func encodeSession(session models.ProjectSession) (string, error) {
	encoded, err := json.Marshal(session)
	if err != nil {
		return "", fmt.Errorf("encode project session: %w", err)
	}
	return string(encoded), nil
}

func normalizeSessionSlices(session *models.ProjectSession) {
	if session.Tabs == nil {
		session.Tabs = make([]models.ProjectTabReference, 0)
	}
	if session.History == nil {
		session.History = make([]models.QueryHistoryEntry, 0)
	}
}

func validateSession(session models.ProjectSession) error {
	if session.Version != models.ProjectSessionVersion {
		return models.NewError(models.CodeInvalidArgument, "Project session version is unsupported", map[string]any{"version": session.Version})
	}
	if session.ResultSequence < 0 {
		return models.NewError(models.CodeInvalidArgument, "Result sequence cannot be negative", nil)
	}
	if len(session.History) > maxQueryHistoryEntries {
		return models.NewError(models.CodeInvalidArgument, "Project session history is too long", map[string]any{"maxEntries": maxQueryHistoryEntries})
	}
	tabIDs := make(map[string]struct{}, len(session.Tabs))
	for _, tab := range session.Tabs {
		if strings.TrimSpace(tab.ID) == "" {
			return models.NewError(models.CodeInvalidArgument, "Project tab ID is required", nil)
		}
		if _, exists := tabIDs[tab.ID]; exists {
			return models.NewError(models.CodeInvalidArgument, "Project tab IDs must be unique", map[string]any{"tabId": tab.ID})
		}
		tabIDs[tab.ID] = struct{}{}
		switch tab.Kind {
		case models.ProjectTabKindLocal:
			if strings.TrimSpace(tab.SourceID) == "" || tab.ConnectionID != "" || tab.RelationID != "" || tab.Catalog != "" || tab.Schema != "" || tab.Relation != "" || tab.RelationType != "" || tab.PlaceholderReason != "" {
				return models.NewError(models.CodeInvalidArgument, "Local project tab identity is invalid", map[string]any{"tabId": tab.ID})
			}
		case models.ProjectTabKindExternal:
			hasCoordinates := tab.Catalog != "" && tab.Schema != "" && tab.Relation != ""
			if tab.SourceID != "" || strings.TrimSpace(tab.ConnectionID) == "" || !hasCoordinates || strings.TrimSpace(tab.RelationType) == "" || tab.PlaceholderReason != "" {
				return models.NewError(models.CodeInvalidArgument, "External project tab identity is invalid", map[string]any{"tabId": tab.ID})
			}
		case models.ProjectTabKindPlaceholder:
			hasExternalIdentity := tab.SourceID == "" && strings.TrimSpace(tab.ConnectionID) != "" && tab.Catalog != "" && tab.Schema != "" && tab.Relation != "" && strings.TrimSpace(tab.RelationType) != ""
			if !hasExternalIdentity || tab.PlaceholderReason != "disconnected" {
				return models.NewError(models.CodeInvalidArgument, "Placeholder project tab identity is invalid", map[string]any{"tabId": tab.ID})
			}
		default:
			return models.NewError(models.CodeInvalidArgument, "Project tab kind is invalid", map[string]any{"tabId": tab.ID, "kind": tab.Kind})
		}
	}
	if session.ActiveTabID != nil {
		if _, exists := tabIDs[*session.ActiveTabID]; !exists {
			return models.NewError(models.CodeInvalidArgument, "Active project tab does not exist", map[string]any{"tabId": *session.ActiveTabID})
		}
	}
	for _, entry := range session.History {
		if strings.TrimSpace(entry.ID) == "" || strings.TrimSpace(entry.SQL) == "" || entry.RanAt.IsZero() {
			return models.NewError(models.CodeInvalidArgument, "Query history entry is incomplete", nil)
		}
		if entry.Status != "success" && entry.Status != "error" {
			return models.NewError(models.CodeInvalidArgument, "Query history status is invalid", map[string]any{"status": entry.Status})
		}
		if entry.DurationMS != nil && *entry.DurationMS < 0 {
			return models.NewError(models.CodeInvalidArgument, "Query duration cannot be negative", nil)
		}
	}
	return nil
}

// reconcileSession drops local tabs whose source metadata no longer belongs to
// this project. This removes stale result tabs after startup result cleanup and
// also heals sessions after a dataset is removed.
func reconcileSession(ctx context.Context, tx *sql.Tx, projectID string, session *models.ProjectSession) (bool, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id FROM ducs_meta.datasets WHERE project_id = ?`, projectID)
	if err != nil {
		return false, err
	}
	existing := make(map[string]struct{})
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return false, err
		}
		existing[id] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return false, err
	}
	if err := rows.Close(); err != nil {
		return false, err
	}
	connectionRows, err := tx.QueryContext(ctx, `SELECT connection_id FROM ducs_meta.project_connections WHERE project_id = ?`, projectID)
	if err != nil {
		return false, err
	}
	linkedConnections := make(map[string]struct{})
	for connectionRows.Next() {
		var id string
		if err := connectionRows.Scan(&id); err != nil {
			_ = connectionRows.Close()
			return false, err
		}
		linkedConnections[id] = struct{}{}
	}
	if err := connectionRows.Err(); err != nil {
		_ = connectionRows.Close()
		return false, err
	}
	if err := connectionRows.Close(); err != nil {
		return false, err
	}

	changed := false
	kept := make([]models.ProjectTabReference, 0, len(session.Tabs))
	for _, tab := range session.Tabs {
		if tab.Kind == models.ProjectTabKindLocal {
			if _, ok := existing[tab.SourceID]; !ok {
				changed = true
				continue
			}
		}
		if tab.Kind == models.ProjectTabKindExternal || tab.Kind == models.ProjectTabKindPlaceholder {
			if _, ok := linkedConnections[tab.ConnectionID]; !ok {
				changed = true
				continue
			}
		}
		kept = append(kept, tab)
	}
	if changed {
		session.Tabs = kept
		if session.ActiveTabID != nil {
			activeExists := false
			for _, tab := range kept {
				if tab.ID == *session.ActiveTabID {
					activeExists = true
					break
				}
			}
			if !activeExists {
				session.ActiveTabID = nil
			}
		}
	}
	normalizeSessionSlices(session)
	return changed, nil
}
