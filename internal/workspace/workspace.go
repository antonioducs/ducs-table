// Package workspace manages project-scoped source, query, connection, and
// session metadata.
package workspace

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"ducs-table/internal/database"
	"ducs-table/internal/models"
)

type Service struct {
	db *database.DB
}

func New(db *database.DB) *Service        { return &Service{db: db} }
func (s *Service) Database() *database.DB { return s.db }

// Bootstrap returns all durable state for one active project.
func (s *Service) Bootstrap(ctx context.Context, projectID string) (models.Workspace, error) {
	project, err := requireProject(ctx, s.db.SQL(), projectID, false)
	if err != nil {
		return models.Workspace{}, err
	}
	sources, err := s.ListSources(ctx, projectID)
	if err != nil {
		return models.Workspace{}, err
	}
	datasets := make([]models.SourceInfo, 0)
	results := make([]models.SourceInfo, 0)
	for _, source := range sources {
		if source.Schema == "result" || source.IsEphemeral {
			results = append(results, source)
		} else {
			datasets = append(datasets, source)
		}
	}
	queries, err := s.ListSavedQueries(ctx, projectID)
	if err != nil {
		return models.Workspace{}, err
	}
	session, err := s.LoadSession(ctx, projectID)
	if err != nil {
		return models.Workspace{}, err
	}
	connectionIDs, err := s.ListConnectionIDs(ctx, projectID)
	if err != nil {
		return models.Workspace{}, err
	}
	return models.Workspace{
		Project:       project,
		Sources:       sources,
		Datasets:      datasets,
		Results:       results,
		SavedQueries:  queries,
		Session:       session,
		ConnectionIDs: connectionIDs,
	}, nil
}

func (s *Service) ListDatasets(ctx context.Context, projectID string) ([]models.SourceInfo, error) {
	return s.listSources(ctx, projectID, "data")
}

func (s *Service) ListResults(ctx context.Context, projectID string) ([]models.SourceInfo, error) {
	return s.listSources(ctx, projectID, "result")
}

func (s *Service) ListSources(ctx context.Context, projectID string) ([]models.SourceInfo, error) {
	return s.listSources(ctx, projectID, "")
}

func (s *Service) listSources(ctx context.Context, projectID, schema string) ([]models.SourceInfo, error) {
	if _, err := requireProject(ctx, s.db.SQL(), projectID, false); err != nil {
		return nil, err
	}
	query := sourceSelect + ` WHERE project_id = ?`
	args := []any{projectID}
	if schema != "" {
		query += ` AND schema_name = ?`
		args = append(args, schema)
	}
	query += ` ORDER BY created_at, id`
	rows, err := s.db.SQL().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, models.WrapError(models.CodeDatabase, "Could not list project sources", err, map[string]any{"projectId": projectID})
	}
	sources := make([]models.SourceInfo, 0)
	for rows.Next() {
		source, scanErr := scanSource(rows)
		if scanErr != nil {
			_ = rows.Close()
			return nil, models.WrapError(models.CodeDatabase, "Could not read project source metadata", scanErr, map[string]any{"projectId": projectID})
		}
		sources = append(sources, source)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, models.WrapError(models.CodeDatabase, "Could not list project sources", err, map[string]any{"projectId": projectID})
	}
	if err := rows.Close(); err != nil {
		return nil, models.WrapError(models.CodeDatabase, "Could not close project source metadata", err, map[string]any{"projectId": projectID})
	}
	for i := range sources {
		columns, err := database.Columns(ctx, s.db.SQL(), sources[i].Schema, sources[i].SQLName)
		if err != nil {
			return nil, models.WrapError(models.CodeDatabase, "Could not inspect source columns", err, map[string]any{"projectId": projectID, "sourceId": sources[i].ID})
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

func (s *Service) GetSource(ctx context.Context, projectID, id string) (models.SourceInfo, error) {
	if strings.TrimSpace(id) == "" {
		return models.SourceInfo{}, models.NewError(models.CodeInvalidArgument, "Source ID is required", nil)
	}
	source, err := GetSource(ctx, s.db.SQL(), projectID, id, true)
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

func (s *Service) GetDataset(ctx context.Context, projectID, id string) (models.SourceInfo, error) {
	return s.GetSource(ctx, projectID, id)
}

// RemoveDataset atomically drops the physical table and scoped metadata.
func (s *Service) RemoveDataset(ctx context.Context, projectID, id string) error {
	if strings.TrimSpace(id) == "" {
		return models.NewError(models.CodeInvalidArgument, "Source ID is required", nil)
	}
	err := s.db.WithTx(ctx, func(tx *sql.Tx) error {
		source, err := GetSource(ctx, tx, projectID, id, false)
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
		_, err = tx.ExecContext(ctx, `DELETE FROM ducs_meta.datasets WHERE project_id = ? AND id = ?`, projectID, id)
		return err
	})
	if err != nil {
		var appErr *models.AppError
		if errors.As(err, &appErr) {
			return appErr
		}
		return models.WrapError(models.CodeDatabase, "Could not remove dataset", err, map[string]any{"projectId": projectID, "sourceId": id})
	}
	return nil
}

func getSnapshotOrigin(ctx context.Context, q database.Queryer, sourceID string) (*models.SnapshotOrigin, error) {
	var origin models.SnapshotOrigin
	var connectionID sql.NullString
	err := q.QueryRowContext(ctx, `
		SELECT connection_id, connection_name, catalog_name, schema_name,
		       relation_name, relation_type, refreshed_at
		FROM ducs_meta.snapshots WHERE source_id = ?`, sourceID).Scan(
		&connectionID, &origin.ConnectionName, &origin.Catalog, &origin.Schema,
		&origin.Relation, &origin.RelationType, &origin.RefreshedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, models.WrapError(models.CodeDatabase, "Could not read snapshot origin metadata", err, map[string]any{"sourceId": sourceID})
	}
	if connectionID.Valid {
		value := connectionID.String
		origin.ConnectionID = &value
	}
	return &origin, nil
}

// InsertSourceTx publishes metadata for one explicit project inside a
// caller-owned transaction.
func InsertSourceTx(ctx context.Context, tx *sql.Tx, projectID string, source models.SourceInfo) error {
	if _, err := requireProject(ctx, tx, projectID, false); err != nil {
		return err
	}
	if source.ProjectID != "" && source.ProjectID != projectID {
		return models.NewError(models.CodeInvalidArgument, "Source belongs to another project", map[string]any{"projectId": projectID, "sourceProjectId": source.ProjectID})
	}
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
			id, project_id, display_name, sql_name, schema_name, source_type,
			source_path, sheet_name, row_count, is_ephemeral, original_query,
			created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), ?, ?, NULLIF(?, ''), ?, ?)`,
		source.ID, projectID, source.DisplayName, source.SQLName, source.Schema, source.SourceType,
		source.SourcePath, source.Sheet, source.RowCount, source.IsEphemeral,
		source.OriginalSQL, source.CreatedAt, source.UpdatedAt)
	return err
}

const sourceSelect = `
	SELECT id, project_id, display_name, sql_name, schema_name, source_type,
	       COALESCE(source_path, ''), COALESCE(sheet_name, ''), row_count,
	       is_ephemeral, COALESCE(original_query, ''), created_at, updated_at
	FROM ducs_meta.datasets`

type rowScanner interface{ Scan(...any) error }

func scanSource(row rowScanner) (models.SourceInfo, error) {
	var source models.SourceInfo
	err := row.Scan(
		&source.ID, &source.ProjectID, &source.DisplayName, &source.SQLName,
		&source.Schema, &source.SourceType, &source.SourcePath, &source.Sheet,
		&source.RowCount, &source.IsEphemeral, &source.OriginalSQL,
		&source.CreatedAt, &source.UpdatedAt,
	)
	return source, err
}

// GetSource is the transaction-friendly source lookup used by importer and
// query services. Both project and source identity are required.
func GetSource(ctx context.Context, q database.Queryer, projectID, id string, withColumns bool) (models.SourceInfo, error) {
	if _, err := requireProject(ctx, q, projectID, false); err != nil {
		return models.SourceInfo{}, err
	}
	source, err := scanSource(q.QueryRowContext(ctx, sourceSelect+` WHERE project_id = ? AND id = ?`, projectID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return models.SourceInfo{}, models.NewError(models.CodeSourceNotFound, "Source was not found in this project", map[string]any{"projectId": projectID, "sourceId": id})
	}
	if err != nil {
		return models.SourceInfo{}, models.WrapError(models.CodeDatabase, "Could not read source metadata", err, map[string]any{"projectId": projectID, "sourceId": id})
	}
	if withColumns {
		columns, err := database.Columns(ctx, q, source.Schema, source.SQLName)
		if err != nil {
			return models.SourceInfo{}, models.WrapError(models.CodeDatabase, "Could not inspect source columns", err, map[string]any{"projectId": projectID, "sourceId": id})
		}
		source.Columns = columns
	}
	return source, nil
}

// DeleteSourceMetadataTx removes one project-scoped metadata row without
// touching its physical table.
func DeleteSourceMetadataTx(ctx context.Context, tx *sql.Tx, projectID, id string) error {
	if _, err := requireProject(ctx, tx, projectID, false); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `DELETE FROM ducs_meta.datasets WHERE project_id = ? AND id = ?`, projectID, id)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return models.NewError(models.CodeSourceNotFound, "Source was not found in this project", map[string]any{"projectId": projectID, "sourceId": id})
	}
	return nil
}

func cleanName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", models.NewError(models.CodeInvalidArgument, "Name is required", nil)
	}
	if utf8.RuneCountInString(name) > 200 {
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
