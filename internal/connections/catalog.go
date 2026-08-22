package connections

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"ducs-table/internal/database"
	"ducs-table/internal/models"
)

func (s *Service) RefreshCatalog(ctx context.Context, projectID, connectionID string) error {
	if err := s.requireProjectConnection(ctx, projectID, connectionID); err != nil {
		return err
	}
	info, err := s.requireConnected(ctx, connectionID)
	if err != nil {
		return err
	}
	err = s.session.WithConn(ctx, func(conn *sql.Conn) error {
		var rows *sql.Rows
		if info.Kind == KindPostgres {
			rows, err = conn.QueryContext(ctx, `CALL pg_clear_cache()`)
		} else {
			rows, err = conn.QueryContext(ctx, `SELECT * FROM mongo_clear_cache()`)
		}
		if err == nil {
			err = rows.Close()
		}
		return err
	})
	if err != nil {
		return models.NewError(models.CodeCatalogLoadFailed, "The external catalog could not be refreshed", map[string]any{"connectionId": connectionID})
	}
	s.mu.Lock()
	s.invalidateLocked(connectionID)
	s.mu.Unlock()
	return nil
}

func (s *Service) ListSchemas(ctx context.Context, projectID, connectionID string) ([]SchemaInfo, error) {
	if err := s.requireProjectConnection(ctx, projectID, connectionID); err != nil {
		return nil, err
	}
	info, err := s.requireConnected(ctx, connectionID)
	if err != nil {
		return nil, err
	}
	result := make([]SchemaInfo, 0)
	err = s.session.WithConn(ctx, func(conn *sql.Conn) error {
		query := `SELECT schema_name FROM information_schema.schemata WHERE catalog_name = ? AND schema_name NOT IN ('information_schema', 'pg_catalog')`
		args := []any{info.CatalogName}
		if info.Kind == KindPostgres && info.Config.Postgres.Schema != "" {
			query += ` AND schema_name = ?`
			args = append(args, info.Config.Postgres.Schema)
		}
		query += ` ORDER BY schema_name`
		rows, queryErr := conn.QueryContext(ctx, query, args...)
		if queryErr != nil {
			return queryErr
		}
		defer rows.Close()
		for rows.Next() {
			var item SchemaInfo
			if scanErr := rows.Scan(&item.Name); scanErr != nil {
				return scanErr
			}
			result = append(result, item)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, models.NewError(models.CodeCatalogLoadFailed, "Could not load schemas from the external database", map[string]any{"connectionId": connectionID})
	}
	return result, nil
}

func (s *Service) ListRelations(ctx context.Context, request ListRelationsRequest) ([]models.ExternalRelationInfo, error) {
	if err := s.requireProjectConnection(ctx, request.ProjectID, request.ConnectionID); err != nil {
		return nil, err
	}
	info, err := s.requireConnected(ctx, request.ConnectionID)
	if err != nil {
		return nil, err
	}
	request.Schema = strings.TrimSpace(request.Schema)
	if request.Schema == "" {
		return nil, models.NewError(models.CodeInvalidArgument, "Schema is required", nil)
	}
	if info.Kind == KindPostgres && info.Config.Postgres.Schema != "" && request.Schema != info.Config.Postgres.Schema {
		return nil, models.NewError(models.CodeInvalidArgument, "Schema is outside this connection's configured scope", nil)
	}
	result := make([]models.ExternalRelationInfo, 0)
	err = s.session.WithConn(ctx, func(conn *sql.Conn) error {
		rows, queryErr := conn.QueryContext(ctx, `SELECT table_name, table_type FROM information_schema.tables WHERE table_catalog = ? AND table_schema = ? ORDER BY table_name`, info.CatalogName, request.Schema)
		if queryErr != nil {
			return queryErr
		}
		defer rows.Close()
		for rows.Next() {
			var name, tableType string
			if scanErr := rows.Scan(&name, &tableType); scanErr != nil {
				return scanErr
			}
			relationType := "table"
			if info.Kind == KindMongo {
				relationType = "collection"
			} else if strings.Contains(strings.ToUpper(tableType), "VIEW") {
				relationType = "view"
			}
			item := models.ExternalRelationInfo{ConnectionID: info.ID, Provider: string(info.Kind), Catalog: info.CatalogName, Schema: request.Schema, Name: name, RelationType: relationType, QualifiedName: database.QuoteQualified(info.CatalogName, request.Schema, name)}
			item.Columns = []models.ColumnInfo{}
			item.DefaultOrder = []string{}
			item.ID = relationID(item.ConnectionID, item.Catalog, item.Schema, item.Name, item.RelationType)
			result = append(result, item)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, models.NewError(models.CodeCatalogLoadFailed, "Could not load relations from the external database", map[string]any{"connectionId": request.ConnectionID, "schema": request.Schema})
	}
	s.mu.Lock()
	if s.connectionRelations[info.ID] == nil {
		s.connectionRelations[info.ID] = make(map[string]struct{})
	}
	for _, item := range result {
		s.relations[item.ID] = item
		s.connectionRelations[info.ID][item.ID] = struct{}{}
	}
	s.mu.Unlock()
	return result, nil
}

func (s *Service) GetExternalRelation(ctx context.Context, projectID, relationIDValue string) (models.ExternalRelationInfo, error) {
	s.mu.RLock()
	relation, ok := s.relations[relationIDValue]
	s.mu.RUnlock()
	if !ok {
		return models.ExternalRelationInfo{}, models.NewError(models.CodeExternalRelationNotFound, "External relation was not found. Refresh its connection catalog", map[string]any{"relationId": relationIDValue})
	}
	if err := s.requireProjectConnection(ctx, projectID, relation.ConnectionID); err != nil {
		return models.ExternalRelationInfo{}, err
	}
	info, err := s.requireConnected(ctx, relation.ConnectionID)
	if err != nil {
		return models.ExternalRelationInfo{}, err
	}
	if len(relation.Columns) > 0 {
		return relation, nil
	}
	err = s.session.WithConn(ctx, func(conn *sql.Conn) error {
		rows, queryErr := conn.QueryContext(ctx, `SELECT column_name, data_type, is_nullable, ordinal_position FROM information_schema.columns WHERE table_catalog = ? AND table_schema = ? AND table_name = ? ORDER BY ordinal_position`, relation.Catalog, relation.Schema, relation.Name)
		if queryErr != nil {
			return queryErr
		}
		defer rows.Close()
		columns := make([]models.ColumnInfo, 0)
		for rows.Next() {
			var column models.ColumnInfo
			var nullable string
			if scanErr := rows.Scan(&column.Name, &column.Type, &nullable, &column.Ordinal); scanErr != nil {
				return scanErr
			}
			column.Nullable = strings.EqualFold(nullable, "YES")
			columns = append(columns, column)
		}
		if rows.Err() != nil {
			return rows.Err()
		}
		if len(columns) == 0 {
			return sql.ErrNoRows
		}
		relation.Columns = columns
		if info.Kind == KindMongo {
			for _, column := range columns {
				if column.Name == "_id" {
					relation.DefaultOrder = []string{"_id"}
					break
				}
			}
		} else {
			relation.DefaultOrder = postgresDefaultOrder(ctx, conn, relation)
		}
		relation.PagingStable = len(relation.DefaultOrder) > 0
		return nil
	})
	if errors.Is(err, sql.ErrNoRows) {
		return models.ExternalRelationInfo{}, models.NewError(models.CodeExternalRelationNotFound, "External relation no longer exists", map[string]any{"relationId": relationIDValue})
	}
	if err != nil {
		return models.ExternalRelationInfo{}, models.NewError(models.CodeCatalogLoadFailed, "Could not inspect the external relation", map[string]any{"relationId": relationIDValue})
	}
	s.mu.Lock()
	s.relations[relation.ID] = relation
	s.mu.Unlock()
	return relation, nil
}

func postgresDefaultOrder(ctx context.Context, conn *sql.Conn, relation models.ExternalRelationInfo) []string {
	rows, err := conn.QueryContext(ctx, `SELECT tc.constraint_name, tc.constraint_type, kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_catalog = kcu.constraint_catalog AND tc.constraint_schema = kcu.constraint_schema AND tc.constraint_name = kcu.constraint_name AND tc.table_name = kcu.table_name WHERE tc.table_catalog = ? AND tc.table_schema = ? AND tc.table_name = ? AND tc.constraint_type IN ('PRIMARY KEY','UNIQUE') ORDER BY CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN 0 ELSE 1 END, tc.constraint_name, kcu.ordinal_position`, relation.Catalog, relation.Schema, relation.Name)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var selected string
	order := make([]string, 0)
	for rows.Next() {
		var constraintName, constraintType, column string
		if rows.Scan(&constraintName, &constraintType, &column) != nil {
			return nil
		}
		if selected == "" {
			selected = constraintName
		}
		if constraintName != selected {
			break
		}
		order = append(order, column)
	}
	return order
}

func (s *Service) ResolveExternal(ctx context.Context, projectID, id string) (models.ExternalRelationInfo, error) {
	return s.GetExternalRelation(ctx, projectID, id)
}

// RestoreExternalRelation rebuilds a durable tab reference from identity
// fields only. Qualified SQL is always generated with backend quoting; no SQL
// text from the persisted session is accepted or executed.
func (s *Service) RestoreExternalRelation(ctx context.Context, projectID string, tab models.ProjectTabReference) (models.ExternalRelationInfo, error) {
	if (tab.Kind != models.ProjectTabKindExternal && tab.Kind != models.ProjectTabKindPlaceholder) || strings.TrimSpace(tab.ConnectionID) == "" ||
		strings.TrimSpace(tab.Catalog) == "" || strings.TrimSpace(tab.Schema) == "" || strings.TrimSpace(tab.Relation) == "" {
		return models.ExternalRelationInfo{}, models.NewError(models.CodeInvalidArgument, "External tab identity is invalid", map[string]any{"tabId": tab.ID})
	}
	if err := s.requireProjectConnection(ctx, projectID, tab.ConnectionID); err != nil {
		return models.ExternalRelationInfo{}, err
	}
	info, err := s.repo.Get(ctx, tab.ConnectionID)
	if err != nil {
		return models.ExternalRelationInfo{}, err
	}
	if tab.Catalog != info.CatalogName {
		return models.ExternalRelationInfo{}, models.NewError(models.CodeExternalRelationNotFound, "External relation no longer matches its connection", map[string]any{"tabId": tab.ID})
	}
	relationType := strings.TrimSpace(tab.RelationType)
	if relationType == "" {
		relationType = "table"
		if info.Kind == KindMongo {
			relationType = "collection"
		}
	}
	relation := models.ExternalRelationInfo{
		ConnectionID:  info.ID,
		Provider:      string(info.Kind),
		Catalog:       info.CatalogName,
		Schema:        tab.Schema,
		Name:          tab.Relation,
		RelationType:  relationType,
		QualifiedName: database.QuoteQualified(info.CatalogName, tab.Schema, tab.Relation),
		Columns:       []models.ColumnInfo{},
		DefaultOrder:  []string{},
	}
	relation.ID = relationID(relation.ConnectionID, relation.Catalog, relation.Schema, relation.Name, relation.RelationType)
	s.mu.Lock()
	s.relations[relation.ID] = relation
	if s.connectionRelations[relation.ConnectionID] == nil {
		s.connectionRelations[relation.ConnectionID] = make(map[string]struct{})
	}
	s.connectionRelations[relation.ConnectionID][relation.ID] = struct{}{}
	s.mu.Unlock()
	if s.status(info.ID) != StatusConnected || !s.session.IsAttached(info.ID) {
		return relation, nil
	}
	detailed, err := s.GetExternalRelation(ctx, projectID, relation.ID)
	if err != nil {
		return relation, err
	}
	return detailed, nil
}

func (s *Service) requireConnected(ctx context.Context, id string) (ConnectionInfo, error) {
	info, err := s.repo.Get(ctx, id)
	if err != nil {
		return ConnectionInfo{}, err
	}
	if s.status(id) != StatusConnected || !s.session.IsAttached(id) {
		return ConnectionInfo{}, models.NewError(models.CodeConnectionNotConnected, "Connect the external database to continue", map[string]any{"connectionId": id})
	}
	return info, nil
}

func (s *Service) invalidateLocked(connectionID string) {
	for id := range s.connectionRelations[connectionID] {
		relation := s.relations[id]
		relation.Columns = []models.ColumnInfo{}
		relation.DefaultOrder = []string{}
		relation.PagingStable = false
		s.relations[id] = relation
	}
}
func (s *Service) removeRelationsLocked(connectionID string) {
	for id := range s.connectionRelations[connectionID] {
		delete(s.relations, id)
	}
	delete(s.connectionRelations, connectionID)
}
