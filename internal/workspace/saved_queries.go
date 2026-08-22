package workspace

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"ducs-table/internal/models"
)

const savedQuerySelect = `
	SELECT id, project_id, name, sql, created_at, updated_at
	FROM ducs_meta.saved_queries`

func (s *Service) ListSavedQueries(ctx context.Context, projectID string) ([]models.SavedQuery, error) {
	if _, err := requireProject(ctx, s.db.SQL(), projectID, false); err != nil {
		return nil, err
	}
	rows, err := s.db.SQL().QueryContext(ctx, savedQuerySelect+`
		WHERE project_id = ? ORDER BY name COLLATE NOCASE, id`, projectID)
	if err != nil {
		return nil, models.WrapError(models.CodeDatabase, "Could not list saved queries", err, map[string]any{"projectId": projectID})
	}
	defer rows.Close()
	queries := make([]models.SavedQuery, 0)
	for rows.Next() {
		query, err := scanSavedQuery(rows)
		if err != nil {
			return nil, models.WrapError(models.CodeDatabase, "Could not read saved query", err, map[string]any{"projectId": projectID})
		}
		queries = append(queries, query)
	}
	if err := rows.Err(); err != nil {
		return nil, models.WrapError(models.CodeDatabase, "Could not list saved queries", err, map[string]any{"projectId": projectID})
	}
	return queries, nil
}

func (s *Service) GetSavedQuery(ctx context.Context, projectID, id string) (models.SavedQuery, error) {
	if strings.TrimSpace(id) == "" {
		return models.SavedQuery{}, models.NewError(models.CodeInvalidArgument, "Saved query ID is required", nil)
	}
	if _, err := requireProject(ctx, s.db.SQL(), projectID, false); err != nil {
		return models.SavedQuery{}, err
	}
	query, err := scanSavedQuery(s.db.SQL().QueryRowContext(ctx, savedQuerySelect+` WHERE project_id = ? AND id = ?`, projectID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return models.SavedQuery{}, savedQueryNotFound(projectID, id)
	}
	if err != nil {
		return models.SavedQuery{}, models.WrapError(models.CodeDatabase, "Could not read saved query", err, map[string]any{"projectId": projectID, "queryId": id})
	}
	return query, nil
}

func (s *Service) CreateSavedQuery(ctx context.Context, projectID, name, querySQL string) (models.SavedQuery, error) {
	name, err := cleanName(name)
	if err != nil {
		return models.SavedQuery{}, err
	}
	querySQL, err = cleanSQL(querySQL)
	if err != nil {
		return models.SavedQuery{}, err
	}
	id, err := models.NewID()
	if err != nil {
		return models.SavedQuery{}, models.WrapError(models.CodeDatabase, "Could not generate a saved query ID", err, nil)
	}
	now := time.Now().UTC()
	query := models.SavedQuery{ID: id, ProjectID: projectID, Name: name, SQL: querySQL, CreatedAt: now, UpdatedAt: now}
	err = s.db.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireProject(ctx, tx, projectID, false); err != nil {
			return err
		}
		if err := ensureSavedQueryNameAvailable(ctx, tx, projectID, name, ""); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `
			INSERT INTO ducs_meta.saved_queries (id, project_id, name, sql, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?)`, id, projectID, name, querySQL, now, now)
		return err
	})
	if err != nil {
		return models.SavedQuery{}, savedQueryMutationError("Could not create saved query", projectID, id, err)
	}
	return query, nil
}

// SaveQuery creates a query when ID is empty and updates it otherwise.
func (s *Service) SaveQuery(ctx context.Context, projectID string, query models.SavedQuery) (models.SavedQuery, error) {
	if query.ProjectID != "" && query.ProjectID != projectID {
		return models.SavedQuery{}, models.NewError(models.CodeInvalidArgument, "Saved query belongs to another project", map[string]any{"projectId": projectID, "queryProjectId": query.ProjectID})
	}
	if strings.TrimSpace(query.ID) == "" {
		return s.CreateSavedQuery(ctx, projectID, query.Name, query.SQL)
	}
	return s.UpdateSavedQuery(ctx, projectID, query.ID, query.Name, query.SQL)
}

func (s *Service) UpdateSavedQuery(ctx context.Context, projectID, id, name, querySQL string) (models.SavedQuery, error) {
	if strings.TrimSpace(id) == "" {
		return models.SavedQuery{}, models.NewError(models.CodeInvalidArgument, "Saved query ID is required", nil)
	}
	name, err := cleanName(name)
	if err != nil {
		return models.SavedQuery{}, err
	}
	querySQL, err = cleanSQL(querySQL)
	if err != nil {
		return models.SavedQuery{}, err
	}
	now := time.Now().UTC()
	err = s.db.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireProject(ctx, tx, projectID, false); err != nil {
			return err
		}
		var exists bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS (
			SELECT 1 FROM ducs_meta.saved_queries WHERE project_id = ? AND id = ?
		)`, projectID, id).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return savedQueryNotFound(projectID, id)
		}
		if err := ensureSavedQueryNameAvailable(ctx, tx, projectID, name, id); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `
			UPDATE ducs_meta.saved_queries SET name = ?, sql = ?, updated_at = ?
			WHERE project_id = ? AND id = ?`, name, querySQL, now, projectID, id)
		return err
	})
	if err != nil {
		return models.SavedQuery{}, savedQueryMutationError("Could not update saved query", projectID, id, err)
	}
	return s.GetSavedQuery(ctx, projectID, id)
}

func (s *Service) DeleteSavedQuery(ctx context.Context, projectID, id string) error {
	if strings.TrimSpace(id) == "" {
		return models.NewError(models.CodeInvalidArgument, "Saved query ID is required", nil)
	}
	err := s.db.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireProject(ctx, tx, projectID, false); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `DELETE FROM ducs_meta.saved_queries WHERE project_id = ? AND id = ?`, projectID, id)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return savedQueryNotFound(projectID, id)
		}
		return nil
	})
	if err != nil {
		return savedQueryMutationError("Could not delete saved query", projectID, id, err)
	}
	return nil
}

func (s *Service) RemoveSavedQuery(ctx context.Context, projectID, id string) error {
	return s.DeleteSavedQuery(ctx, projectID, id)
}

func ensureSavedQueryNameAvailable(ctx context.Context, tx *sql.Tx, projectID, name, exceptID string) error {
	var exists bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS (
		SELECT 1 FROM ducs_meta.saved_queries
		WHERE project_id = ? AND lower(name) = lower(?) AND id <> ?
	)`, projectID, name, exceptID).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return models.NewError(models.CodeConflict, "A saved query with this name already exists in the project", map[string]any{"projectId": projectID, "name": name})
	}
	return nil
}

func scanSavedQuery(row rowScanner) (models.SavedQuery, error) {
	var query models.SavedQuery
	err := row.Scan(&query.ID, &query.ProjectID, &query.Name, &query.SQL, &query.CreatedAt, &query.UpdatedAt)
	return query, err
}

func savedQueryNotFound(projectID, id string) error {
	return models.NewError(models.CodeNotFound, "Saved query was not found in this project", map[string]any{"projectId": projectID, "queryId": id})
}

func savedQueryMutationError(message, projectID, id string, err error) error {
	var appErr *models.AppError
	if errors.As(err, &appErr) {
		return appErr
	}
	return models.WrapError(models.CodeDatabase, message, err, map[string]any{"projectId": projectID, "queryId": id})
}
