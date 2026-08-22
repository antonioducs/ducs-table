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

const projectSelect = `
	SELECT id, name, description, archived_at, last_opened_at, created_at, updated_at
	FROM ducs_meta.projects`

// ListProjects returns active projects by default and includes archived
// projects only when explicitly requested.
func (s *Service) ListProjects(ctx context.Context, includeArchived bool) ([]models.Project, error) {
	query := projectSelect
	if !includeArchived {
		query += ` WHERE archived_at IS NULL`
	}
	query += ` ORDER BY created_at, id`
	rows, err := s.db.SQL().QueryContext(ctx, query)
	if err != nil {
		return nil, models.WrapError(models.CodeDatabase, "Could not list projects", err, nil)
	}
	defer rows.Close()
	projects := make([]models.Project, 0)
	for rows.Next() {
		project, err := scanProject(rows)
		if err != nil {
			return nil, models.WrapError(models.CodeDatabase, "Could not read project metadata", err, nil)
		}
		projects = append(projects, project)
	}
	if err := rows.Err(); err != nil {
		return nil, models.WrapError(models.CodeDatabase, "Could not list projects", err, nil)
	}
	return projects, nil
}

// InitialProject chooses the most recently opened active project. If none has
// ever been opened, it returns the oldest active project.
func (s *Service) InitialProject(ctx context.Context) (models.Project, error) {
	project, err := scanProject(s.db.SQL().QueryRowContext(ctx, projectSelect+`
		WHERE archived_at IS NULL
		ORDER BY CASE WHEN last_opened_at IS NULL THEN 1 ELSE 0 END,
		         last_opened_at DESC, created_at, id
		LIMIT 1`))
	if errors.Is(err, sql.ErrNoRows) {
		return models.Project{}, models.NewError(models.CodeProjectNotFound, "No active project was found", nil)
	}
	if err != nil {
		return models.Project{}, models.WrapError(models.CodeDatabase, "Could not choose the initial project", err, nil)
	}
	return project, nil
}

func (s *Service) GetInitialProject(ctx context.Context) (models.Project, error) {
	return s.InitialProject(ctx)
}

// GetProject reads project metadata even when the project is archived.
func (s *Service) GetProject(ctx context.Context, projectID string) (models.Project, error) {
	return requireProject(ctx, s.db.SQL(), projectID, true)
}

// OpenProject marks an active project as the most recently opened project.
func (s *Service) OpenProject(ctx context.Context, projectID string) (models.Project, error) {
	if strings.TrimSpace(projectID) == "" {
		return models.Project{}, models.NewError(models.CodeInvalidArgument, "Project ID is required", nil)
	}
	now := time.Now().UTC()
	err := s.db.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireProject(ctx, tx, projectID, false); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `UPDATE ducs_meta.projects SET last_opened_at = ?, updated_at = ? WHERE id = ?`, now, now, projectID)
		return err
	})
	if err != nil {
		return models.Project{}, projectMutationError("Could not open project", projectID, err)
	}
	return s.GetProject(ctx, projectID)
}

func (s *Service) CreateProject(ctx context.Context, name, description string) (models.Project, error) {
	name, description, err := cleanProjectFields(name, description)
	if err != nil {
		return models.Project{}, err
	}
	id, err := models.NewID()
	if err != nil {
		return models.Project{}, models.WrapError(models.CodeDatabase, "Could not generate a project ID", err, nil)
	}
	now := time.Now().UTC()
	project := models.Project{ID: id, Name: name, Description: description, CreatedAt: now, UpdatedAt: now}
	err = s.db.WithTx(ctx, func(tx *sql.Tx) error {
		if err := ensureProjectNameAvailable(ctx, tx, name, ""); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO ducs_meta.projects (id, name, description, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?)`, id, name, description, now, now); err != nil {
			return err
		}
		empty, err := encodeSession(emptySession())
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO ducs_meta.project_sessions (project_id, state_json, updated_at) VALUES (?, ?, ?)`, id, empty, now)
		return err
	})
	if err != nil {
		return models.Project{}, projectMutationError("Could not create project", id, err)
	}
	return project, nil
}

func (s *Service) UpdateProject(ctx context.Context, projectID, name, description string) (models.Project, error) {
	if strings.TrimSpace(projectID) == "" {
		return models.Project{}, models.NewError(models.CodeInvalidArgument, "Project ID is required", nil)
	}
	name, description, err := cleanProjectFields(name, description)
	if err != nil {
		return models.Project{}, err
	}
	now := time.Now().UTC()
	err = s.db.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireProject(ctx, tx, projectID, false); err != nil {
			return err
		}
		if err := ensureProjectNameAvailable(ctx, tx, name, projectID); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `UPDATE ducs_meta.projects SET name = ?, description = ?, updated_at = ? WHERE id = ?`, name, description, now, projectID)
		return err
	})
	if err != nil {
		return models.Project{}, projectMutationError("Could not update project", projectID, err)
	}
	return s.GetProject(ctx, projectID)
}

func (s *Service) ArchiveProject(ctx context.Context, projectID string) (models.Project, error) {
	if strings.TrimSpace(projectID) == "" {
		return models.Project{}, models.NewError(models.CodeInvalidArgument, "Project ID is required", nil)
	}
	now := time.Now().UTC()
	err := s.db.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireProject(ctx, tx, projectID, false); err != nil {
			return err
		}
		var activeCount int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM ducs_meta.projects WHERE archived_at IS NULL`).Scan(&activeCount); err != nil {
			return err
		}
		if activeCount <= 1 {
			return models.NewError(models.CodeConflict, "The final active project cannot be archived", map[string]any{"projectId": projectID})
		}
		_, err := tx.ExecContext(ctx, `UPDATE ducs_meta.projects SET archived_at = ?, updated_at = ? WHERE id = ?`, now, now, projectID)
		return err
	})
	if err != nil {
		return models.Project{}, projectMutationError("Could not archive project", projectID, err)
	}
	return s.GetProject(ctx, projectID)
}

func (s *Service) RestoreProject(ctx context.Context, projectID string) (models.Project, error) {
	if strings.TrimSpace(projectID) == "" {
		return models.Project{}, models.NewError(models.CodeInvalidArgument, "Project ID is required", nil)
	}
	now := time.Now().UTC()
	err := s.db.WithTx(ctx, func(tx *sql.Tx) error {
		project, err := requireProject(ctx, tx, projectID, true)
		if err != nil {
			return err
		}
		if project.ArchivedAt == nil {
			return nil
		}
		_, err = tx.ExecContext(ctx, `UPDATE ducs_meta.projects SET archived_at = NULL, updated_at = ? WHERE id = ?`, now, projectID)
		return err
	})
	if err != nil {
		return models.Project{}, projectMutationError("Could not restore project", projectID, err)
	}
	return s.GetProject(ctx, projectID)
}

func requireProject(ctx context.Context, q database.Queryer, projectID string, allowArchived bool) (models.Project, error) {
	trimmedID := strings.TrimSpace(projectID)
	if trimmedID == "" {
		return models.Project{}, models.NewError(models.CodeInvalidArgument, "Project ID is required", nil)
	}
	if trimmedID != projectID {
		return models.Project{}, models.NewError(models.CodeInvalidArgument, "Project ID is invalid", nil)
	}
	project, err := scanProject(q.QueryRowContext(ctx, projectSelect+` WHERE id = ?`, projectID))
	if errors.Is(err, sql.ErrNoRows) {
		return models.Project{}, models.NewError(models.CodeProjectNotFound, "Project was not found", map[string]any{"projectId": projectID})
	}
	if err != nil {
		return models.Project{}, models.WrapError(models.CodeDatabase, "Could not read project metadata", err, map[string]any{"projectId": projectID})
	}
	if !allowArchived && project.ArchivedAt != nil {
		return models.Project{}, models.NewError(models.CodeProjectArchived, "Project is archived", map[string]any{"projectId": projectID})
	}
	return project, nil
}

type projectRowScanner interface{ Scan(...any) error }

func scanProject(row projectRowScanner) (models.Project, error) {
	var project models.Project
	var archivedAt, lastOpenedAt sql.NullTime
	err := row.Scan(&project.ID, &project.Name, &project.Description, &archivedAt, &lastOpenedAt, &project.CreatedAt, &project.UpdatedAt)
	if archivedAt.Valid {
		value := archivedAt.Time
		project.ArchivedAt = &value
	}
	if lastOpenedAt.Valid {
		value := lastOpenedAt.Time
		project.LastOpenedAt = &value
	}
	return project, err
}

func cleanProjectFields(name, description string) (string, string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", "", models.NewError(models.CodeInvalidArgument, "Project name is required", nil)
	}
	if utf8.RuneCountInString(name) > 200 {
		return "", "", models.NewError(models.CodeInvalidArgument, "Project name is too long", map[string]any{"maxLength": 200})
	}
	if utf8.RuneCountInString(description) > 1000 {
		return "", "", models.NewError(models.CodeInvalidArgument, "Project description is too long", map[string]any{"maxLength": 1000})
	}
	return name, description, nil
}

func ensureProjectNameAvailable(ctx context.Context, q database.Queryer, name, exceptID string) error {
	var exists bool
	if err := q.QueryRowContext(ctx, `SELECT EXISTS (
		SELECT 1 FROM ducs_meta.projects WHERE lower(name) = lower(?) AND id <> ?
	)`, name, exceptID).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return models.NewError(models.CodeConflict, "A project with this name already exists", map[string]any{"name": name})
	}
	return nil
}

func projectMutationError(message, projectID string, err error) error {
	var appErr *models.AppError
	if errors.As(err, &appErr) {
		return appErr
	}
	return models.WrapError(models.CodeDatabase, message, err, map[string]any{"projectId": projectID})
}
