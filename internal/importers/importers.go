package importers

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"time"

	"ducs-table/internal/database"
	"ducs-table/internal/extensions"
	"ducs-table/internal/models"
	"ducs-table/internal/workspace"
)

const maxPreviewRows = 200

type Service struct {
	db         *database.DB
	extensions *extensions.Manager
}

func New(db *database.DB, managers ...*extensions.Manager) *Service {
	manager := extensions.NewManager()
	if len(managers) > 0 && managers[0] != nil {
		manager = managers[0]
	}
	return &Service{db: db, extensions: manager}
}

func (s *Service) Validate(path string) (FileInfo, error)   { return ValidateFile(path) }
func (s *Service) ListSheets(path string) ([]string, error) { return ListSheets(path) }

func (s *Service) Preview(ctx context.Context, path string, options Options, sheet string, limit int) (PreviewResult, error) {
	return s.PreviewFile(ctx, PreviewRequest{Path: path, Options: options, Sheet: sheet, Limit: limit})
}

func (s *Service) PreviewFile(ctx context.Context, request PreviewRequest) (PreviewResult, error) {
	if request.Limit <= 0 {
		request.Limit = 50
	}
	if request.Limit > maxPreviewRows {
		return PreviewResult{}, models.NewError(models.CodeInvalidArgument, "Preview limit cannot exceed 200 rows", map[string]any{"max": maxPreviewRows})
	}
	file, err := ValidateFile(request.Path)
	if err != nil {
		return PreviewResult{}, err
	}
	var sheets []string
	if file.Type == FileXLSX {
		sheets, request.Sheet, err = selectSheet(file.Path, request.Sheet)
		if err != nil {
			return PreviewResult{}, err
		}
	}
	attempts, err := buildReaderAttempts(file, request.Options, request.Sheet)
	if err != nil {
		return PreviewResult{}, err
	}
	conn, err := s.db.SQL().Conn(ctx)
	if err != nil {
		return PreviewResult{}, models.WrapError(models.CodeDatabase, "Could not open preview connection", err, nil)
	}
	defer conn.Close()
	if file.Type == FileXLSX {
		if err := s.extensions.Ensure(ctx, conn, "excel"); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
				return PreviewResult{}, models.WrapError(models.CodeCancelled, "Preview was cancelled", context.Canceled, nil)
			}
			return PreviewResult{}, err
		}
	}

	var lastErr error
	for _, attempt := range attempts {
		query := "SELECT * FROM " + attempt.expression + " LIMIT ?"
		args := append(append([]any(nil), attempt.args...), request.Limit)
		rows, queryErr := conn.QueryContext(ctx, query, args...)
		if queryErr != nil {
			lastErr = queryErr
			continue
		}
		columns, columnErr := previewColumns(rows)
		if columnErr != nil {
			_ = rows.Close()
			lastErr = columnErr
			continue
		}
		values, scanErr := database.ScanRows(rows)
		if scanErr != nil {
			lastErr = scanErr
			continue
		}
		return PreviewResult{File: file, Sheets: sheets, Sheet: request.Sheet, Columns: columns, Rows: values}, nil
	}
	if errors.Is(lastErr, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
		return PreviewResult{}, models.WrapError(models.CodeCancelled, "Preview was cancelled", context.Canceled, nil)
	}
	return PreviewResult{}, readerFailure(file.Type, lastErr)
}

func previewColumns(rows *sql.Rows) ([]models.ColumnInfo, error) {
	names, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	types, err := rows.ColumnTypes()
	if err != nil {
		return nil, err
	}
	columns := make([]models.ColumnInfo, len(names))
	for i, name := range names {
		columns[i] = models.ColumnInfo{Name: name, Type: types[i].DatabaseTypeName(), Ordinal: i + 1}
		if nullable, ok := types[i].Nullable(); ok {
			columns[i].Nullable = nullable
		}
	}
	return columns, nil
}

// Materialize streams a source through DuckDB into an isolated staging table
// and publishes table + metadata atomically only after count/schema succeed.
func (s *Service) Materialize(ctx context.Context, request MaterializeRequest) (models.SourceInfo, error) {
	request.ProjectID = strings.TrimSpace(request.ProjectID)
	if request.ProjectID == "" {
		return models.SourceInfo{}, models.NewError(models.CodeInvalidArgument, "Project ID is required", nil)
	}
	file, err := ValidateFile(request.Path)
	if err != nil {
		return models.SourceInfo{}, err
	}
	if file.Type == FileXLSX {
		_, request.Sheet, err = selectSheet(file.Path, request.Sheet)
		if err != nil {
			return models.SourceInfo{}, err
		}
	}
	attempts, err := buildReaderAttempts(file, request.Options, request.Sheet)
	if err != nil {
		return models.SourceInfo{}, err
	}
	displayName := strings.TrimSpace(request.DisplayName)
	if displayName == "" {
		displayName = strings.TrimSuffix(file.Name, filepath.Ext(file.Name))
		if file.Type == FileXLSX && request.Sheet != "" {
			displayName += " — " + request.Sheet
		}
	}
	desiredSQLName := strings.TrimSpace(request.SQLName)
	if desiredSQLName == "" {
		desiredSQLName = displayName
	}
	id := strings.TrimSpace(request.ID)
	if id == "" {
		id, err = models.NewID()
		if err != nil {
			return models.SourceInfo{}, models.WrapError(models.CodeDatabase, "Could not generate source ID", err, nil)
		}
	}
	staging := "__staging_" + strings.ReplaceAll(id, "-", "")

	var created models.SourceInfo
	var lastErr error
	err = s.db.WithMutation(ctx, func(conn *sql.Conn) error {
		if file.Type == FileXLSX {
			if err := s.extensions.Ensure(ctx, conn, "excel"); err != nil {
				return err
			}
		}
		for _, attempt := range attempts {
			created, lastErr = s.materializeAttempt(ctx, conn, file, request, displayName, desiredSQLName, id, staging, attempt)
			if lastErr == nil {
				return nil
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
		}
		return lastErr
	})
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
			return models.SourceInfo{}, models.WrapError(models.CodeCancelled, "Import was cancelled", context.Canceled, nil)
		}
		var appErr *models.AppError
		if errors.As(err, &appErr) {
			return models.SourceInfo{}, appErr
		}
		return models.SourceInfo{}, readerFailure(file.Type, err)
	}
	return created, nil
}

func (s *Service) materializeAttempt(
	ctx context.Context,
	conn *sql.Conn,
	file FileInfo,
	request MaterializeRequest,
	displayName, desiredSQLName, id, staging string,
	attempt readerAttempt,
) (models.SourceInfo, error) {
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return models.SourceInfo{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	stagingQualified := database.QuoteQualified("data", staging)
	if _, err := tx.ExecContext(ctx, "DROP TABLE IF EXISTS "+stagingQualified); err != nil {
		return models.SourceInfo{}, err
	}
	createSQL := "CREATE TABLE " + stagingQualified + " AS SELECT * FROM " + attempt.expression
	if _, err := tx.ExecContext(ctx, createSQL, attempt.args...); err != nil {
		return models.SourceInfo{}, err
	}
	var rowCount int64
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+stagingQualified).Scan(&rowCount); err != nil {
		return models.SourceInfo{}, err
	}
	finalName, err := database.UniqueTableName(ctx, tx, "data", desiredSQLName)
	if err != nil {
		return models.SourceInfo{}, err
	}
	if _, err := tx.ExecContext(ctx, "ALTER TABLE "+stagingQualified+" RENAME TO "+database.QuoteIdentifier(finalName)); err != nil {
		return models.SourceInfo{}, err
	}
	columns, err := database.Columns(ctx, tx, "data", finalName)
	if err != nil {
		return models.SourceInfo{}, err
	}
	now := time.Now().UTC()
	source := models.SourceInfo{
		ID: id, ProjectID: request.ProjectID, DisplayName: displayName, SQLName: finalName, Schema: "data",
		SourceType: string(file.Type), SourcePath: file.Path, Sheet: request.Sheet,
		RowCount: rowCount, Columns: columns, CreatedAt: now, UpdatedAt: now,
	}
	if err := workspace.InsertSourceTx(ctx, tx, request.ProjectID, source); err != nil {
		return models.SourceInfo{}, err
	}
	if err := tx.Commit(); err != nil {
		return models.SourceInfo{}, err
	}
	committed = true
	return source, nil
}

// MaterializePath is a compact synchronous API suitable for invocation from a
// jobs.Task.
func (s *Service) MaterializePath(ctx context.Context, projectID, path, displayName, sheet string, options Options) (models.SourceInfo, error) {
	return s.Materialize(ctx, MaterializeRequest{ProjectID: projectID, Path: path, DisplayName: displayName, Sheet: sheet, Options: options})
}
