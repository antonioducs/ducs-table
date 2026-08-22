package connections

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"ducs-table/internal/database"
	"ducs-table/internal/models"
	"ducs-table/internal/workspace"
)

type snapshotRecord struct {
	SourceID                                                string
	ConnectionID                                            *string
	ConnectionName, Catalog, Schema, Relation, RelationType string
	RefreshedAt                                             time.Time
}

func (s *Service) CreateSnapshot(ctx context.Context, request SnapshotRequest) (models.SourceInfo, error) {
	relation, err := s.GetExternalRelation(ctx, request.ProjectID, request.RelationID)
	if err != nil {
		return models.SourceInfo{}, err
	}
	connection, err := s.requireConnected(ctx, relation.ConnectionID)
	if err != nil {
		return models.SourceInfo{}, err
	}
	display := strings.TrimSpace(request.DisplayName)
	if display == "" {
		display = relation.Name + " snapshot"
	}
	if len(display) > 200 {
		return models.SourceInfo{}, models.NewError(models.CodeInvalidArgument, "Snapshot name is too long", nil)
	}
	desired := strings.TrimSpace(request.SQLName)
	if desired == "" {
		desired = display
	}
	id, err := models.NewID()
	if err != nil {
		return models.SourceInfo{}, models.NewError(models.CodeDatabase, "Could not create a snapshot ID", nil)
	}
	staging := "__staging_" + strings.ReplaceAll(id, "-", "")
	var source models.SourceInfo
	err = s.session.WithTx(ctx, func(tx *sql.Tx) error {
		stagingQualified := database.QuoteQualified("data", staging)
		if _, execErr := tx.ExecContext(ctx, "DROP TABLE IF EXISTS "+stagingQualified); execErr != nil {
			return execErr
		}
		if _, execErr := tx.ExecContext(ctx, "CREATE TABLE "+stagingQualified+" AS SELECT * FROM "+relation.QualifiedName); execErr != nil {
			return execErr
		}
		var count int64
		if queryErr := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+stagingQualified).Scan(&count); queryErr != nil {
			return queryErr
		}
		finalName, nameErr := database.UniqueTableName(ctx, tx, "data", desired)
		if nameErr != nil {
			return nameErr
		}
		if _, execErr := tx.ExecContext(ctx, "ALTER TABLE "+stagingQualified+" RENAME TO "+database.QuoteIdentifier(finalName)); execErr != nil {
			return execErr
		}
		columns, columnErr := database.Columns(ctx, tx, "data", finalName)
		if columnErr != nil {
			return columnErr
		}
		now := nowUTC()
		connectionID := connection.ID
		origin := &models.SnapshotOrigin{ConnectionID: &connectionID, ConnectionName: connection.Name, Catalog: relation.Catalog, Schema: relation.Schema, Relation: relation.Name, RelationType: relation.RelationType, RefreshedAt: now}
		source = models.SourceInfo{ID: id, ProjectID: request.ProjectID, DisplayName: display, SQLName: finalName, Schema: "data", SourceType: "snapshot", RowCount: count, Columns: columns, Snapshot: origin, CreatedAt: now, UpdatedAt: now}
		if insertErr := workspace.InsertSourceTx(ctx, tx, request.ProjectID, source); insertErr != nil {
			return insertErr
		}
		_, insertErr := tx.ExecContext(ctx, `INSERT INTO ducs_meta.snapshots (source_id, connection_id, connection_name, catalog_name, schema_name, relation_name, relation_type, refreshed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, connection.ID, connection.Name, relation.Catalog, relation.Schema, relation.Name, relation.RelationType, now)
		return insertErr
	})
	if err != nil {
		return models.SourceInfo{}, snapshotError(ctx, err, "Could not create the local snapshot")
	}
	return source, nil
}

func (s *Service) RefreshSnapshot(ctx context.Context, projectID, sourceID string) (models.SourceInfo, error) {
	record, err := s.getSnapshotRecord(ctx, projectID, sourceID)
	if err != nil {
		return models.SourceInfo{}, err
	}
	if record.ConnectionID == nil {
		return models.SourceInfo{}, models.NewError(models.CodeConnectionNotFound, "The original connection was removed; this snapshot remains available offline", map[string]any{"sourceId": sourceID})
	}
	connection, err := s.requireConnected(ctx, *record.ConnectionID)
	if err != nil {
		return models.SourceInfo{}, err
	}
	record.ConnectionName = connection.Name
	relation := models.ExternalRelationInfo{ConnectionID: *record.ConnectionID, Provider: string(connection.Kind), Catalog: record.Catalog, Schema: record.Schema, Name: record.Relation, RelationType: record.RelationType, QualifiedName: database.QuoteQualified(record.Catalog, record.Schema, record.Relation)}
	relation.ID = relationID(relation.ConnectionID, relation.Catalog, relation.Schema, relation.Name, relation.RelationType)
	s.mu.Lock()
	s.relations[relation.ID] = relation
	if s.connectionRelations[relation.ConnectionID] == nil {
		s.connectionRelations[relation.ConnectionID] = make(map[string]struct{})
	}
	s.connectionRelations[relation.ConnectionID][relation.ID] = struct{}{}
	s.mu.Unlock()
	if relation, err = s.GetExternalRelation(ctx, projectID, relation.ID); err != nil {
		return models.SourceInfo{}, err
	}
	current, err := s.workspace.GetSource(ctx, projectID, sourceID)
	if err != nil {
		return models.SourceInfo{}, err
	}
	staging := "__staging_" + strings.ReplaceAll(sourceID, "-", "") + "_refresh"
	backup := "__snapshot_backup_" + strings.ReplaceAll(sourceID, "-", "")
	var refreshed models.SourceInfo
	err = s.session.WithTx(ctx, func(tx *sql.Tx) error {
		stagingQualified := database.QuoteQualified("data", staging)
		finalQualified := database.QuoteQualified("data", current.SQLName)
		backupQualified := database.QuoteQualified("data", backup)
		if _, execErr := tx.ExecContext(ctx, "DROP TABLE IF EXISTS "+stagingQualified); execErr != nil {
			return execErr
		}
		if _, execErr := tx.ExecContext(ctx, "DROP TABLE IF EXISTS "+backupQualified); execErr != nil {
			return execErr
		}
		if _, execErr := tx.ExecContext(ctx, "CREATE TABLE "+stagingQualified+" AS SELECT * FROM "+relation.QualifiedName); execErr != nil {
			return execErr
		}
		var count int64
		if queryErr := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+stagingQualified).Scan(&count); queryErr != nil {
			return queryErr
		}
		if _, execErr := tx.ExecContext(ctx, "ALTER TABLE "+finalQualified+" RENAME TO "+database.QuoteIdentifier(backup)); execErr != nil {
			return execErr
		}
		if _, execErr := tx.ExecContext(ctx, "ALTER TABLE "+stagingQualified+" RENAME TO "+database.QuoteIdentifier(current.SQLName)); execErr != nil {
			return execErr
		}
		if _, execErr := tx.ExecContext(ctx, "DROP TABLE "+backupQualified); execErr != nil {
			return execErr
		}
		columns, columnErr := database.Columns(ctx, tx, "data", current.SQLName)
		if columnErr != nil {
			return columnErr
		}
		now := nowUTC()
		if _, execErr := tx.ExecContext(ctx, `UPDATE ducs_meta.datasets SET row_count = ?, updated_at = ? WHERE id = ? AND project_id = ?`, count, now, sourceID, projectID); execErr != nil {
			return execErr
		}
		if _, execErr := tx.ExecContext(ctx, `UPDATE ducs_meta.snapshots SET refreshed_at = ?, connection_name = ?, catalog_name = ?, schema_name = ?, relation_name = ?, relation_type = ? WHERE source_id = ?`, now, record.ConnectionName, record.Catalog, record.Schema, record.Relation, record.RelationType, sourceID); execErr != nil {
			return execErr
		}
		refreshed = current
		refreshed.RowCount = count
		refreshed.Columns = columns
		refreshed.UpdatedAt = now
		refreshed.Snapshot = &models.SnapshotOrigin{ConnectionID: record.ConnectionID, ConnectionName: record.ConnectionName, Catalog: record.Catalog, Schema: record.Schema, Relation: record.Relation, RelationType: record.RelationType, RefreshedAt: now}
		return nil
	})
	if err != nil {
		return models.SourceInfo{}, snapshotError(ctx, err, "Could not refresh the local snapshot; the previous version was preserved")
	}
	return refreshed, nil
}

func (s *Service) getSnapshotRecord(ctx context.Context, projectID, sourceID string) (snapshotRecord, error) {
	var record snapshotRecord
	var connectionID sql.NullString
	err := s.db.SQL().QueryRowContext(ctx, `SELECT s.source_id, s.connection_id, s.connection_name, s.catalog_name, s.schema_name, s.relation_name, s.relation_type, s.refreshed_at
		FROM ducs_meta.snapshots s JOIN ducs_meta.datasets d ON d.id = s.source_id
		WHERE s.source_id = ? AND d.project_id = ?`, sourceID, projectID).Scan(&record.SourceID, &connectionID, &record.ConnectionName, &record.Catalog, &record.Schema, &record.Relation, &record.RelationType, &record.RefreshedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return snapshotRecord{}, models.NewError(models.CodeNotFound, "Snapshot metadata was not found", map[string]any{"sourceId": sourceID})
	}
	if err != nil {
		return snapshotRecord{}, models.NewError(models.CodeDatabase, "Could not read snapshot metadata", nil)
	}
	if connectionID.Valid {
		record.ConnectionID = &connectionID.String
	}
	return record, nil
}

func snapshotError(ctx context.Context, err error, message string) error {
	if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
		return models.NewError(models.CodeCancelled, "Snapshot operation was cancelled; the previous version was preserved", nil)
	}
	var appErr *models.AppError
	if errors.As(err, &appErr) {
		return appErr
	}
	return models.NewError(models.CodeSnapshotFailed, message, nil)
}
