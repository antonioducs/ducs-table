// Package export streams validated DuckDB SELECTs directly to local files.
package exports

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"ducs-table/internal/database"
	"ducs-table/internal/grid"
	"ducs-table/internal/models"
	"ducs-table/internal/workspace"
)

type Scope string

const (
	ScopeEntire      Scope = "entire"
	ScopeCurrentView Scope = "current-view"
)

type CSVRequest struct {
	ProjectID      string                 `json:"projectId"`
	Resource       models.GridResourceRef `json:"resource"`
	SourceID       string                 `json:"sourceId"`
	Destination    string                 `json:"destination"`
	Scope          Scope                  `json:"scope"`
	Filters        []grid.Filter          `json:"filters,omitempty"`
	Sorts          []grid.Sort            `json:"sorts,omitempty"`
	VisibleColumns []string               `json:"visibleColumns,omitempty"`
}

type Result struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

type Service struct {
	db   *database.DB
	grid *grid.Service
}

func New(db *database.DB, gridServices ...*grid.Service) *Service {
	var gridService *grid.Service
	if len(gridServices) > 0 {
		gridService = gridServices[0]
	}
	if gridService == nil {
		gridService = grid.New(db)
	}
	return &Service{db: db, grid: gridService}
}

// NewWithWorkspace builds the grid dependency from an existing workspace.
func NewWithWorkspace(db *database.DB, workspaceService *workspace.Service) *Service {
	return New(db, grid.New(db, workspaceService))
}

// ExportCSV executes DuckDB COPY over a controlled SELECT. No table rows cross
// the Go boundary.
func (s *Service) ExportCSV(ctx context.Context, request CSVRequest) (Result, error) {
	destination := strings.TrimSpace(request.Destination)
	if destination == "" {
		return Result{}, models.NewError(models.CodeInvalidArgument, "CSV destination is required", nil)
	}
	if strings.IndexByte(destination, 0) >= 0 {
		return Result{}, models.NewError(models.CodeInvalidArgument, "CSV destination contains an invalid character", nil)
	}
	absDestination, err := filepath.Abs(destination)
	if err != nil {
		return Result{}, models.WrapError(models.CodeIO, "Could not resolve CSV destination", err, nil)
	}
	parentInfo, err := os.Stat(filepath.Dir(absDestination))
	if err != nil {
		return Result{}, models.WrapError(models.CodeIO, "CSV destination directory is unavailable", err, nil)
	}
	if !parentInfo.IsDir() {
		return Result{}, models.NewError(models.CodeInvalidArgument, "CSV destination parent is not a directory", nil)
	}
	if info, statErr := os.Stat(absDestination); statErr == nil && info.IsDir() {
		return Result{}, models.NewError(models.CodeInvalidArgument, "CSV destination must be a file", nil)
	} else if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return Result{}, models.WrapError(models.CodeIO, "Could not inspect CSV destination", statErr, nil)
	}

	scope := request.Scope
	if scope == "" {
		scope = ScopeEntire
	}
	resource := request.Resource
	if resource.Kind == "" && request.SourceID != "" {
		resource = models.GridResourceRef{Kind: "source", SourceID: request.SourceID}
	}
	selectRequest := grid.SelectRequest{ProjectID: request.ProjectID, Resource: resource, SourceID: request.SourceID}
	switch scope {
	case ScopeEntire:
		// Intentionally leave view controls empty.
	case ScopeCurrentView:
		selectRequest.Columns = request.VisibleColumns
		selectRequest.Filters = request.Filters
		selectRequest.Sorts = request.Sorts
	default:
		return Result{}, models.NewError(models.CodeInvalidArgument, "CSV export scope is invalid", map[string]any{"scope": scope})
	}
	built, err := s.grid.BuildSelect(ctx, selectRequest, false)
	if err != nil {
		return Result{}, err
	}
	copySQL := "COPY (" + built.SQL + ") TO " + database.QuotePathLiteral(absDestination) + " (FORMAT CSV, HEADER TRUE)"
	err = s.grid.WithResourceConn(ctx, request.ProjectID, resource, func(conn *sql.Conn) error {
		_, execErr := conn.ExecContext(ctx, copySQL, built.Args...)
		return execErr
	})
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
			return Result{}, models.WrapError(models.CodeCancelled, "CSV export was cancelled", context.Canceled, nil)
		}
		return Result{}, models.WrapError(models.CodeIO, "Could not export CSV", err, nil)
	}
	info, err := os.Stat(absDestination)
	if err != nil {
		return Result{}, models.WrapError(models.CodeIO, "Could not inspect exported CSV", err, nil)
	}
	return Result{Path: absDestination, Size: info.Size()}, nil
}

func (s *Service) Export(ctx context.Context, request CSVRequest) (Result, error) {
	return s.ExportCSV(ctx, request)
}
