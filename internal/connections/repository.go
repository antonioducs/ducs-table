package connections

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"ducs-table/internal/database"
	"ducs-table/internal/models"
)

type Repository struct{ db *database.DB }

func NewRepository(db *database.DB) *Repository { return &Repository{db: db} }

func (r *Repository) List(ctx context.Context) ([]ConnectionInfo, error) {
	rows, err := r.db.SQL().QueryContext(ctx, connectionSelect+" ORDER BY created_at, id")
	if err != nil {
		return nil, models.NewError(models.CodeDatabase, "Could not list database connections", nil)
	}
	defer rows.Close()
	result := make([]ConnectionInfo, 0)
	for rows.Next() {
		info, scanErr := scanConnection(rows)
		if scanErr != nil {
			return nil, models.NewError(models.CodeDatabase, "Could not read connection metadata", nil)
		}
		result = append(result, info)
	}
	if rows.Err() != nil {
		return nil, models.NewError(models.CodeDatabase, "Could not list database connections", nil)
	}
	return result, nil
}

func (r *Repository) Get(ctx context.Context, id string) (ConnectionInfo, error) {
	if strings.TrimSpace(id) == "" {
		return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "Connection ID is required", nil)
	}
	info, err := scanConnection(r.db.SQL().QueryRowContext(ctx, connectionSelect+" WHERE id = ?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return ConnectionInfo{}, models.NewError(models.CodeConnectionNotFound, "Connection was not found", map[string]any{"connectionId": id})
	}
	if err != nil {
		return ConnectionInfo{}, models.NewError(models.CodeDatabase, "Could not read connection metadata", nil)
	}
	return info, nil
}

func (r *Repository) CatalogExists(ctx context.Context, catalog string, exceptID string) (bool, error) {
	var exists bool
	err := r.db.SQL().QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM ducs_meta.connections WHERE catalog_name = ? AND id <> ?)`, catalog, exceptID).Scan(&exists)
	if err != nil {
		return false, models.NewError(models.CodeDatabase, "Could not validate the SQL catalog alias", nil)
	}
	return exists, nil
}

func (r *Repository) Create(ctx context.Context, info ConnectionInfo) error {
	config, err := json.Marshal(info.Config)
	if err != nil {
		return models.NewError(models.CodeInvalidArgument, "Connection configuration is invalid", nil)
	}
	return r.db.WithTx(ctx, func(tx *sql.Tx) error {
		var exists bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM ducs_meta.connections WHERE catalog_name = ?)`, info.CatalogName).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return models.NewError(models.CodeConnectionAlreadyExists, "A connection already uses this SQL catalog alias", map[string]any{"catalogName": info.CatalogName})
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO ducs_meta.connections (id, name, kind, catalog_name, config_json, auto_connect, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, info.ID, info.Name, info.Kind, info.CatalogName, string(config), info.AutoConnect, info.CreatedAt, info.UpdatedAt)
		return err
	})
}

func (r *Repository) Update(ctx context.Context, info ConnectionInfo) error {
	config, err := json.Marshal(info.Config)
	if err != nil {
		return models.NewError(models.CodeInvalidArgument, "Connection configuration is invalid", nil)
	}
	return r.db.WithTx(ctx, func(tx *sql.Tx) error {
		result, execErr := tx.ExecContext(ctx, `UPDATE ducs_meta.connections SET name = ?, config_json = ?, auto_connect = ?, updated_at = ? WHERE id = ?`, info.Name, string(config), info.AutoConnect, info.UpdatedAt, info.ID)
		if execErr != nil {
			return models.NewError(models.CodeDatabase, "Could not update connection metadata", nil)
		}
		if affected, _ := result.RowsAffected(); affected == 0 {
			return models.NewError(models.CodeConnectionNotFound, "Connection was not found", map[string]any{"connectionId": info.ID})
		}
		if _, execErr := tx.ExecContext(ctx, `UPDATE ducs_meta.snapshots SET connection_name = ? WHERE connection_id = ?`, info.Name, info.ID); execErr != nil {
			return models.NewError(models.CodeDatabase, "Could not update snapshot origin metadata", nil)
		}
		return nil
	})
}

// Delete deliberately detaches snapshot metadata from the connection before
// deleting it. Snapshot descriptions and local datasets remain intact.
func (r *Repository) Delete(ctx context.Context, id string) error {
	return r.db.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE ducs_meta.snapshots SET connection_id = NULL WHERE connection_id = ?`, id); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `DELETE FROM ducs_meta.connections WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if affected, _ := result.RowsAffected(); affected == 0 {
			return models.NewError(models.CodeConnectionNotFound, "Connection was not found", map[string]any{"connectionId": id})
		}
		return nil
	})
}

const connectionSelect = `SELECT id, name, kind, catalog_name, config_json, auto_connect, created_at, updated_at FROM ducs_meta.connections`

type rowScanner interface{ Scan(...any) error }

func scanConnection(row rowScanner) (ConnectionInfo, error) {
	var info ConnectionInfo
	var kind, config string
	if err := row.Scan(&info.ID, &info.Name, &kind, &info.CatalogName, &config, &info.AutoConnect, &info.CreatedAt, &info.UpdatedAt); err != nil {
		return ConnectionInfo{}, err
	}
	info.Kind = ConnectionKind(kind)
	if err := json.Unmarshal([]byte(config), &info.Config); err != nil {
		return ConnectionInfo{}, err
	}
	info.Status = StatusDisconnected
	return info, nil
}

func nowUTC() time.Time { return time.Now().UTC() }
