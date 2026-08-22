// Package query validates read-only SQL and manages materialized query results.
package query

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"ducs-table/internal/database"
	"ducs-table/internal/models"
	"ducs-table/internal/workspace"
)

type QueryResultInfo struct {
	Source      models.SourceInfo   `json:"source"`
	Columns     []models.ColumnInfo `json:"columns"`
	RowCount    int64               `json:"rowCount"`
	DurationMS  int64               `json:"durationMs"`
	OriginalSQL string              `json:"originalSql"`
}

type SaveResultRequest struct {
	ResultID    string `json:"resultId"`
	DisplayName string `json:"displayName"`
	SQLName     string `json:"sqlName,omitempty"`
	Copy        bool   `json:"copy,omitempty"`
}

type Service struct {
	db *database.DB
}

func New(db *database.DB) *Service { return &Service{db: db} }

// Run materializes a read-only query into result.__tmp_<uuid> and registers it
// as ephemeral in the same transaction.
func (s *Service) Run(ctx context.Context, userSQL string) (QueryResultInfo, error) {
	validated, err := ValidateReadOnly(userSQL)
	if err != nil {
		return QueryResultInfo{}, err
	}
	id, err := models.NewID()
	if err != nil {
		return QueryResultInfo{}, models.WrapError(models.CodeDatabase, "Could not generate query result ID", err, nil)
	}
	tableName := "__tmp_" + strings.ReplaceAll(id, "-", "")
	qualified := database.QuoteQualified("result", tableName)
	started := time.Now()
	var source models.SourceInfo
	err = s.db.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "SET search_path = 'data,result,main'"); err != nil {
			return err
		}
		wrapped := "CREATE TABLE " + qualified + " AS SELECT * FROM (\n" + validated + "\n) AS user_query"
		if _, err := tx.ExecContext(ctx, wrapped); err != nil {
			return err
		}
		var count int64
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+qualified).Scan(&count); err != nil {
			return err
		}
		columns, err := database.Columns(ctx, tx, "result", tableName)
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		source = models.SourceInfo{
			ID: id, DisplayName: "Query result", SQLName: tableName, Schema: "result",
			SourceType: "query", RowCount: count, Columns: columns, IsEphemeral: true,
			OriginalSQL: strings.TrimSpace(userSQL), CreatedAt: now, UpdatedAt: now,
		}
		return workspace.InsertSourceTx(ctx, tx, source)
	})
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
			return QueryResultInfo{}, models.WrapError(models.CodeCancelled, "Query was cancelled", context.Canceled, nil)
		}
		var appErr *models.AppError
		if errors.As(err, &appErr) {
			return QueryResultInfo{}, appErr
		}
		return QueryResultInfo{}, models.WrapError(models.CodeInvalidQuery, "Query could not be executed", err, nil)
	}
	duration := time.Since(started)
	return QueryResultInfo{
		Source: source, Columns: source.Columns, RowCount: source.RowCount,
		DurationMS: duration.Milliseconds(), OriginalSQL: source.OriginalSQL,
	}, nil
}

// SaveResultAsTable moves an ephemeral result into the persistent data schema.
func (s *Service) SaveResultAsTable(ctx context.Context, resultID, displayName string) (models.SourceInfo, error) {
	return s.SaveResult(ctx, SaveResultRequest{ResultID: resultID, DisplayName: displayName})
}

// SaveResult supports either an atomic move (default) or copy. Copy keeps the
// original ephemeral result and gives the persistent table a new source ID.
func (s *Service) SaveResult(ctx context.Context, request SaveResultRequest) (models.SourceInfo, error) {
	request.ResultID = strings.TrimSpace(request.ResultID)
	request.DisplayName = strings.TrimSpace(request.DisplayName)
	if request.ResultID == "" {
		return models.SourceInfo{}, models.NewError(models.CodeInvalidArgument, "Result ID is required", nil)
	}
	if request.DisplayName == "" {
		return models.SourceInfo{}, models.NewError(models.CodeInvalidArgument, "Saved table name is required", nil)
	}
	desired := strings.TrimSpace(request.SQLName)
	if desired == "" {
		desired = request.DisplayName
	}
	var saved models.SourceInfo
	err := s.db.WithTx(ctx, func(tx *sql.Tx) error {
		result, err := workspace.GetSource(ctx, tx, request.ResultID, false)
		if err != nil {
			return err
		}
		if result.Schema != "result" || !result.IsEphemeral {
			return models.NewError(models.CodeInvalidArgument, "Source is not an ephemeral query result", map[string]any{"sourceId": request.ResultID})
		}
		finalName, err := database.UniqueTableName(ctx, tx, "data", desired)
		if err != nil {
			return err
		}
		from := database.QuoteQualified(result.Schema, result.SQLName)
		to := database.QuoteQualified("data", finalName)
		if _, err := tx.ExecContext(ctx, "CREATE TABLE "+to+" AS SELECT * FROM "+from+" ORDER BY rowid"); err != nil {
			return err
		}
		columns, err := database.Columns(ctx, tx, "data", finalName)
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		if request.Copy {
			newID, err := models.NewID()
			if err != nil {
				return err
			}
			saved = result
			saved.ID = newID
			saved.DisplayName = request.DisplayName
			saved.SQLName = finalName
			saved.Schema = "data"
			saved.IsEphemeral = false
			saved.Columns = columns
			saved.CreatedAt = now
			saved.UpdatedAt = now
			return workspace.InsertSourceTx(ctx, tx, saved)
		}
		if _, err := tx.ExecContext(ctx, "DROP TABLE "+from); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE ducs_meta.datasets
			SET display_name = ?, sql_name = ?, schema_name = 'data', is_ephemeral = FALSE, updated_at = ?
			WHERE id = ?`, request.DisplayName, finalName, now, result.ID); err != nil {
			return err
		}
		saved = result
		saved.DisplayName = request.DisplayName
		saved.SQLName = finalName
		saved.Schema = "data"
		saved.IsEphemeral = false
		saved.Columns = columns
		saved.UpdatedAt = now
		return nil
	})
	if err != nil {
		var appErr *models.AppError
		if errors.As(err, &appErr) {
			return models.SourceInfo{}, appErr
		}
		return models.SourceInfo{}, models.WrapError(models.CodeDatabase, "Could not save query result", err, map[string]any{"resultId": request.ResultID})
	}
	return saved, nil
}

// CloseResult permanently drops an ephemeral result. Repeated calls after the
// first return SOURCE_NOT_FOUND, making accidental dataset deletion impossible.
func (s *Service) CloseResult(ctx context.Context, resultID string) error {
	resultID = strings.TrimSpace(resultID)
	if resultID == "" {
		return models.NewError(models.CodeInvalidArgument, "Result ID is required", nil)
	}
	err := s.db.WithTx(ctx, func(tx *sql.Tx) error {
		result, err := workspace.GetSource(ctx, tx, resultID, false)
		if err != nil {
			return err
		}
		if result.Schema != "result" || !result.IsEphemeral {
			return models.NewError(models.CodeInvalidArgument, "Source is not an ephemeral query result", map[string]any{"sourceId": resultID})
		}
		if _, err := tx.ExecContext(ctx, "DROP TABLE "+database.QuoteQualified(result.Schema, result.SQLName)); err != nil {
			return err
		}
		return workspace.DeleteSourceMetadataTx(ctx, tx, resultID)
	})
	if err != nil {
		var appErr *models.AppError
		if errors.As(err, &appErr) {
			return appErr
		}
		return models.WrapError(models.CodeDatabase, "Could not close query result", err, nil)
	}
	return nil
}
