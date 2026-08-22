// Package extensions explicitly installs and loads the small set of DuckDB
// extensions Duc's Table is allowed to use. DuckDB autoload/autoinstall remain
// disabled at the database layer.
package extensions

import (
	"context"
	"database/sql"
	"errors"
	"sync"

	"ducs-table/internal/models"
)

type Executor interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

type Definition struct {
	Name         string
	Community    bool
	Experimental bool
}

var allowed = map[string]Definition{
	"excel":    {Name: "excel"},
	"postgres": {Name: "postgres"},
	"mongo":    {Name: "mongo", Community: true, Experimental: true},
}

type Manager struct {
	mu sync.Mutex
}

func NewManager() *Manager { return &Manager{} }

func DefinitionFor(name string) (Definition, bool) {
	definition, ok := allowed[name]
	return definition, ok
}

// Ensure is idempotent for a DuckDB connection: it first tries the local
// extension cache, serializes the install retry, and never accepts a repository
// or extension name supplied by the frontend.
func (m *Manager) Ensure(ctx context.Context, executor Executor, name string) error {
	definition, ok := allowed[name]
	if !ok {
		return models.NewError(models.CodeExtensionUnavailable, "This DuckDB extension is not allowed", nil)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, err := executor.ExecContext(ctx, "LOAD "+definition.Name); err == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := executor.ExecContext(ctx, "LOAD "+definition.Name); err == nil {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	install := "INSTALL " + definition.Name
	if definition.Community {
		install += " FROM community"
	}
	if _, err := executor.ExecContext(ctx, install); err != nil {
		return unavailable(definition, err)
	}
	if _, err := executor.ExecContext(ctx, "LOAD "+definition.Name); err != nil {
		return unavailable(definition, err)
	}
	return nil
}

func unavailable(definition Definition, cause error) error {
	if errors.Is(cause, context.Canceled) || errors.Is(cause, context.DeadlineExceeded) {
		return cause
	}
	if definition.Name == "excel" {
		return models.NewError(models.CodeXLSXExtensionUnavailable, "The DuckDB Excel extension is unavailable", nil)
	}
	if definition.Experimental {
		return models.NewError(models.CodeExperimentalExtensionUnavailable, "The experimental MongoDB extension is unavailable for this Mac", nil)
	}
	return models.NewError(models.CodeExtensionUnavailable, "The required DuckDB extension is unavailable", map[string]any{"extension": definition.Name})
}
