package workspace

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"ducs-table/internal/models"
)

func (s *Service) AttachConnection(ctx context.Context, projectID, connectionID string) error {
	if strings.TrimSpace(connectionID) == "" {
		return models.NewError(models.CodeInvalidArgument, "Connection ID is required", nil)
	}
	err := s.db.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireProject(ctx, tx, projectID, false); err != nil {
			return err
		}
		var exists bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM ducs_meta.connections WHERE id = ?)`, connectionID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return models.NewError(models.CodeConnectionNotFound, "Connection was not found", map[string]any{"connectionId": connectionID})
		}
		_, err := tx.ExecContext(ctx, `
			INSERT INTO ducs_meta.project_connections (project_id, connection_id)
			VALUES (?, ?) ON CONFLICT DO NOTHING`, projectID, connectionID)
		return err
	})
	if err != nil {
		var appErr *models.AppError
		if errors.As(err, &appErr) {
			return appErr
		}
		return models.WrapError(models.CodeDatabase, "Could not attach connection to project", err, map[string]any{"projectId": projectID, "connectionId": connectionID})
	}
	return nil
}

func (s *Service) Attach(ctx context.Context, projectID, connectionID string) error {
	return s.AttachConnection(ctx, projectID, connectionID)
}

func (s *Service) DetachConnection(ctx context.Context, projectID, connectionID string) error {
	if strings.TrimSpace(connectionID) == "" {
		return models.NewError(models.CodeInvalidArgument, "Connection ID is required", nil)
	}
	err := s.db.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireProject(ctx, tx, projectID, false); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM ducs_meta.project_connections WHERE project_id = ? AND connection_id = ?`, projectID, connectionID)
		return err
	})
	if err != nil {
		var appErr *models.AppError
		if errors.As(err, &appErr) {
			return appErr
		}
		return models.WrapError(models.CodeDatabase, "Could not detach connection from project", err, map[string]any{"projectId": projectID, "connectionId": connectionID})
	}
	return nil
}

func (s *Service) Detach(ctx context.Context, projectID, connectionID string) error {
	return s.DetachConnection(ctx, projectID, connectionID)
}

func (s *Service) ListConnectionIDs(ctx context.Context, projectID string) ([]string, error) {
	if _, err := requireProject(ctx, s.db.SQL(), projectID, false); err != nil {
		return nil, err
	}
	rows, err := s.db.SQL().QueryContext(ctx, `
		SELECT connection_id FROM ducs_meta.project_connections
		WHERE project_id = ? ORDER BY connection_id`, projectID)
	if err != nil {
		return nil, models.WrapError(models.CodeDatabase, "Could not list project connections", err, map[string]any{"projectId": projectID})
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, models.WrapError(models.CodeDatabase, "Could not read project connection", err, map[string]any{"projectId": projectID})
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, models.WrapError(models.CodeDatabase, "Could not list project connections", err, map[string]any{"projectId": projectID})
	}
	return ids, nil
}

func (s *Service) ListProjectConnectionIDs(ctx context.Context, projectID string) ([]string, error) {
	return s.ListConnectionIDs(ctx, projectID)
}

// ConnectionUsageCount reports how many projects currently reference a
// connection, including archived projects.
func (s *Service) ConnectionUsageCount(ctx context.Context, connectionID string) (int, error) {
	if strings.TrimSpace(connectionID) == "" {
		return 0, models.NewError(models.CodeInvalidArgument, "Connection ID is required", nil)
	}
	var count int
	if err := s.db.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM ducs_meta.project_connections WHERE connection_id = ?`, connectionID).Scan(&count); err != nil {
		return 0, models.WrapError(models.CodeDatabase, "Could not count connection usage", err, map[string]any{"connectionId": connectionID})
	}
	return count, nil
}

func (s *Service) CountConnectionUsage(ctx context.Context, connectionID string) (int, error) {
	return s.ConnectionUsageCount(ctx, connectionID)
}
