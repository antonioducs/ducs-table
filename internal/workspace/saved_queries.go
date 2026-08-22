package workspace

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"ducs-table/internal/models"
)

const savedQuerySelect = `SELECT id, name, sql, created_at, updated_at FROM ducs_meta.saved_queries`

func (s *Service) ListSavedQueries(ctx context.Context) ([]models.SavedQuery, error) {
	rows, err := s.db.SQL().QueryContext(ctx, savedQuerySelect+` ORDER BY name COLLATE NOCASE, id`)
	if err != nil {
		return nil, models.WrapError(models.CodeDatabase, "Could not list saved queries", err, nil)
	}
	defer rows.Close()
	queries := make([]models.SavedQuery, 0)
	for rows.Next() {
		var query models.SavedQuery
		if err := rows.Scan(&query.ID, &query.Name, &query.SQL, &query.CreatedAt, &query.UpdatedAt); err != nil {
			return nil, models.WrapError(models.CodeDatabase, "Could not read saved query", err, nil)
		}
		queries = append(queries, query)
	}
	if err := rows.Err(); err != nil {
		return nil, models.WrapError(models.CodeDatabase, "Could not list saved queries", err, nil)
	}
	return queries, nil
}

func (s *Service) GetSavedQuery(ctx context.Context, id string) (models.SavedQuery, error) {
	var query models.SavedQuery
	err := s.db.SQL().QueryRowContext(ctx, savedQuerySelect+` WHERE id = ?`, id).
		Scan(&query.ID, &query.Name, &query.SQL, &query.CreatedAt, &query.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return models.SavedQuery{}, models.NewError(models.CodeNotFound, "Saved query was not found", map[string]any{"queryId": id})
	}
	if err != nil {
		return models.SavedQuery{}, models.WrapError(models.CodeDatabase, "Could not read saved query", err, nil)
	}
	return query, nil
}

func (s *Service) CreateSavedQuery(ctx context.Context, name, querySQL string) (models.SavedQuery, error) {
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
		return models.SavedQuery{}, models.WrapError(models.CodeDatabase, "Could not generate saved query ID", err, nil)
	}
	now := time.Now().UTC()
	query := models.SavedQuery{ID: id, Name: name, SQL: querySQL, CreatedAt: now, UpdatedAt: now}
	err = s.db.WithTx(ctx, func(tx *sql.Tx) error {
		var exists bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM ducs_meta.saved_queries WHERE lower(name) = lower(?))`, name).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return models.NewError(models.CodeConflict, "A saved query with this name already exists", map[string]any{"name": name})
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO ducs_meta.saved_queries (id, name, sql, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, id, name, querySQL, now, now)
		return err
	})
	if err != nil {
		var appErr *models.AppError
		if errors.As(err, &appErr) {
			return models.SavedQuery{}, appErr
		}
		return models.SavedQuery{}, models.WrapError(models.CodeDatabase, "Could not create saved query", err, nil)
	}
	return query, nil
}

// SaveQuery creates a query when ID is empty and updates it otherwise.
func (s *Service) SaveQuery(ctx context.Context, query models.SavedQuery) (models.SavedQuery, error) {
	if strings.TrimSpace(query.ID) == "" {
		return s.CreateSavedQuery(ctx, query.Name, query.SQL)
	}
	return s.UpdateSavedQuery(ctx, query.ID, query.Name, query.SQL)
}

func (s *Service) UpdateSavedQuery(ctx context.Context, id, name, querySQL string) (models.SavedQuery, error) {
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
		var exists, conflict bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM ducs_meta.saved_queries WHERE id = ?)`, id).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return models.NewError(models.CodeNotFound, "Saved query was not found", map[string]any{"queryId": id})
		}
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM ducs_meta.saved_queries WHERE lower(name) = lower(?) AND id <> ?)`, name, id).Scan(&conflict); err != nil {
			return err
		}
		if conflict {
			return models.NewError(models.CodeConflict, "A saved query with this name already exists", map[string]any{"name": name})
		}
		_, err := tx.ExecContext(ctx, `UPDATE ducs_meta.saved_queries SET name = ?, sql = ?, updated_at = ? WHERE id = ?`, name, querySQL, now, id)
		return err
	})
	if err != nil {
		var appErr *models.AppError
		if errors.As(err, &appErr) {
			return models.SavedQuery{}, appErr
		}
		return models.SavedQuery{}, models.WrapError(models.CodeDatabase, "Could not update saved query", err, nil)
	}
	return s.GetSavedQuery(ctx, id)
}

func (s *Service) DeleteSavedQuery(ctx context.Context, id string) error {
	if strings.TrimSpace(id) == "" {
		return models.NewError(models.CodeInvalidArgument, "Saved query ID is required", nil)
	}
	return s.db.WithTx(ctx, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, `DELETE FROM ducs_meta.saved_queries WHERE id = ?`, id)
		if err != nil {
			return models.WrapError(models.CodeDatabase, "Could not delete saved query", err, nil)
		}
		count, err := result.RowsAffected()
		if err != nil {
			return models.WrapError(models.CodeDatabase, "Could not verify saved query deletion", err, nil)
		}
		if count == 0 {
			return models.NewError(models.CodeNotFound, "Saved query was not found", map[string]any{"queryId": id})
		}
		return nil
	})
}

func (s *Service) RemoveSavedQuery(ctx context.Context, id string) error {
	return s.DeleteSavedQuery(ctx, id)
}
