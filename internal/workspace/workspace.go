// Package workspace manages persistent dataset and saved-query metadata.
package workspace

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"ducs-table/internal/database"
	"ducs-table/internal/models"
)

// Service exposes the small, persistent workspace catalog.
type Service struct {
	db *database.DB
}

func New(db *database.DB) *Service        { return &Service{db: db} }
func (s *Service) Database() *database.DB { return s.db }

// Bootstrap returns all metadata needed to restore the desktop state.
func (s *Service) Bootstrap(ctx context.Context) (models.BootstrapState, error) {
	datasets, err := s.ListDatasets(ctx)
	if err != nil {
		return models.BootstrapState{}, err
	}
	results, err := s.ListResults(ctx)
	if err != nil {
		return models.BootstrapState{}, err
	}
	queries, err := s.ListSavedQueries(ctx)
	if err != nil {
		return models.BootstrapState{}, err
	}
	return models.BootstrapState{Datasets: datasets, Results: results, SavedQueries: queries}, nil
}

func (s *Service) ListDatasets(ctx context.Context) ([]models.SourceInfo, error) {
	return s.listSources(ctx, "data")
}

func (s *Service) ListResults(ctx context.Context) ([]models.SourceInfo, error) {
	return s.listSources(ctx, "result")
}

func (s *Service) ListSources(ctx context.Context) ([]models.SourceInfo, error) {
	return s.listSources(ctx, "")
}

func (s *Service) listSources(ctx context.Context, schema string) ([]models.SourceInfo, error) {
	query := sourceSelect
	args := make([]any, 0, 1)
	if schema != "" {
		query += ` WHERE schema_name = ?`
		args = append(args, schema)
	}
	query += ` ORDER BY created_at, id`
	rows, err := s.db.SQL().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, models.WrapError(models.CodeDatabase, "Could not list workspace sources", err, nil)
	}
	sources := make([]models.SourceInfo, 0)
	for rows.Next() {
		source, scanErr := scanSource(rows)
		if scanErr != nil {
			_ = rows.Close()
			return nil, models.WrapError(models.CodeDatabase, "Could not read workspace metadata", scanErr, nil)
		}
		sources = append(sources, source)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, models.WrapError(models.CodeDatabase, "Could not list workspace sources", err, nil)
	}
	if err := rows.Close(); err != nil {
		return nil, models.WrapError(models.CodeDatabase, "Could not close workspace metadata", err, nil)
	}
	for i := range sources {
		columns, err := database.Columns(ctx, s.db.SQL(), sources[i].Schema, sources[i].SQLName)
		if err != nil {
			return nil, models.WrapError(models.CodeDatabase, "Could not inspect source columns", err, map[string]any{"sourceId": sources[i].ID})
		}
		sources[i].Columns = columns
		origin, err := getSnapshotOrigin(ctx, s.db.SQL(), sources[i].ID)
		if err != nil {
			return nil, err
		}
		sources[i].Snapshot = origin
	}
	return sources, nil
}

// GetSource resolves a source ID to trusted catalog metadata and current columns.
func (s *Service) GetSource(ctx context.Context, id string) (models.SourceInfo, error) {
	if strings.TrimSpace(id) == "" {
		return models.SourceInfo{}, models.NewError(models.CodeInvalidArgument, "Source ID is required", nil)
	}
	source, err := GetSource(ctx, s.db.SQL(), id, true)
	if err != nil {
		return models.SourceInfo{}, err
	}
	origin, err := getSnapshotOrigin(ctx, s.db.SQL(), source.ID)
	if err != nil {
		return models.SourceInfo{}, err
	}
	source.Snapshot = origin
	return source, nil
}

func (s *Service) GetDataset(ctx context.Context, id string) (models.SourceInfo, error) {
	return s.GetSource(ctx, id)
}

// RemoveDataset atomically drops the physical table and its metadata.
func (s *Service) RemoveDataset(ctx context.Context, id string) error {
	if strings.TrimSpace(id) == "" {
		return models.NewError(models.CodeInvalidArgument, "Source ID is required", nil)
	}
	err := s.db.WithTx(ctx, func(tx *sql.Tx) error {
		source, err := GetSource(ctx, tx, id, false)
		if err != nil {
			return err
		}
		if source.Schema != "data" || source.IsEphemeral {
			return models.NewError(models.CodeInvalidArgument, "Source is not a removable dataset", map[string]any{"sourceId": id})
		}
		if _, err := tx.ExecContext(ctx, "DROP TABLE "+database.QuoteQualified(source.Schema, source.SQLName)); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM ducs_meta.snapshots WHERE source_id = ?`, id); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM ducs_meta.datasets WHERE id = ?`, id)
		return err
	})
	if err != nil {
		var appErr *models.AppError
		if errors.As(err, &appErr) {
			return appErr
		}
		return models.WrapError(models.CodeDatabase, "Could not remove dataset", err, map[string]any{"sourceId": id})
	}
	return nil
}

func getSnapshotOrigin(ctx context.Context, q database.Queryer, sourceID string) (*models.SnapshotOrigin, error) {
	var origin models.SnapshotOrigin
	var connectionID sql.NullString
	err := q.QueryRowContext(ctx, `SELECT connection_id, connection_name, catalog_name, schema_name, relation_name, relation_type, refreshed_at FROM ducs_meta.snapshots WHERE source_id = ?`, sourceID).Scan(
		&connectionID, &origin.ConnectionName, &origin.Catalog, &origin.Schema, &origin.Relation, &origin.RelationType, &origin.RefreshedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, models.NewError(models.CodeDatabase, "Could not read snapshot origin metadata", nil)
	}
	if connectionID.Valid {
		value := connectionID.String
		origin.ConnectionID = &value
	}
	return &origin, nil
}

// InsertSourceTx publishes source metadata inside a caller-owned transaction.
// It is exported for importer/query services that create the physical table in
// the same atomic operation.
func InsertSourceTx(ctx context.Context, tx *sql.Tx, source models.SourceInfo) error {
	if source.ID == "" || source.DisplayName == "" || source.SQLName == "" || source.Schema == "" || source.SourceType == "" {
		return models.NewError(models.CodeInvalidArgument, "Source metadata is incomplete", nil)
	}
	if source.Schema != "data" && source.Schema != "result" {
		return models.NewError(models.CodeInvalidArgument, "Source schema is invalid", map[string]any{"schema": source.Schema})
	}
	if source.RowCount < 0 {
		return models.NewError(models.CodeInvalidArgument, "Source row count cannot be negative", nil)
	}
	now := time.Now().UTC()
	if source.CreatedAt.IsZero() {
		source.CreatedAt = now
	}
	if source.UpdatedAt.IsZero() {
		source.UpdatedAt = source.CreatedAt
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO ducs_meta.datasets (
			id, display_name, sql_name, schema_name, source_type, source_path,
			sheet_name, row_count, is_ephemeral, original_query, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), ?, ?, NULLIF(?, ''), ?, ?)`,
		source.ID, source.DisplayName, source.SQLName, source.Schema, source.SourceType,
		source.SourcePath, source.Sheet, source.RowCount, source.IsEphemeral,
		source.OriginalSQL, source.CreatedAt, source.UpdatedAt)
	return err
}

const sourceSelect = `
	SELECT id, display_name, sql_name, schema_name, source_type,
	       COALESCE(source_path, ''), COALESCE(sheet_name, ''), row_count,
	       is_ephemeral, COALESCE(original_query, ''), created_at, updated_at
	FROM ducs_meta.datasets`

type rowScanner interface{ Scan(...any) error }

func scanSource(row rowScanner) (models.SourceInfo, error) {
	var source models.SourceInfo
	err := row.Scan(
		&source.ID, &source.DisplayName, &source.SQLName, &source.Schema,
		&source.SourceType, &source.SourcePath, &source.Sheet, &source.RowCount,
		&source.IsEphemeral, &source.OriginalSQL, &source.CreatedAt, &source.UpdatedAt,
	)
	return source, err
}

// GetSource can be used inside a service transaction. q must be a *sql.DB,
// *sql.Conn, or *sql.Tx.
func GetSource(ctx context.Context, q database.Queryer, id string, withColumns bool) (models.SourceInfo, error) {
	source, err := scanSource(q.QueryRowContext(ctx, sourceSelect+` WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return models.SourceInfo{}, models.NewError(models.CodeSourceNotFound, "Source was not found", map[string]any{"sourceId": id})
	}
	if err != nil {
		return models.SourceInfo{}, models.WrapError(models.CodeDatabase, "Could not read source metadata", err, map[string]any{"sourceId": id})
	}
	if withColumns {
		columns, err := database.Columns(ctx, q, source.Schema, source.SQLName)
		if err != nil {
			return models.SourceInfo{}, models.WrapError(models.CodeDatabase, "Could not inspect source columns", err, map[string]any{"sourceId": id})
		}
		source.Columns = columns
	}
	return source, nil
}

// DeleteSourceMetadataTx removes one metadata row without touching its table.
func DeleteSourceMetadataTx(ctx context.Context, tx *sql.Tx, id string) error {
	_, err := tx.ExecContext(ctx, `DELETE FROM ducs_meta.datasets WHERE id = ?`, id)
	return err
}

func cleanName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", models.NewError(models.CodeInvalidArgument, "Name is required", nil)
	}
	if len(name) > 200 {
		return "", models.NewError(models.CodeInvalidArgument, "Name is too long", map[string]any{"maxLength": 200})
	}
	return name, nil
}

func cleanSQL(query string) (string, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return "", models.NewError(models.CodeInvalidArgument, "SQL is required", nil)
	}
	return query, nil
}
