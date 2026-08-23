package ai

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"ducs-table/internal/connections"
	"ducs-table/internal/database"
	"ducs-table/internal/models"
)

const (
	maxToolRows     = 100
	maxToolBytes    = 256 * 1024
	maxToolTimeout  = 10 * time.Second
	maxRelationPage = 100
	approvalTimeout = 5 * time.Minute
)

type SourceCatalog interface {
	ListSources(context.Context, string) ([]models.SourceInfo, error)
}

type ConnectionCatalog interface {
	ListProjectConnections(context.Context, string) ([]connections.ConnectionInfo, error)
	ListSchemas(context.Context, string, string) ([]connections.SchemaInfo, error)
	ListRelations(context.Context, connections.ListRelationsRequest) ([]models.ExternalRelationInfo, error)
	GetExternalRelation(context.Context, string, string) (models.ExternalRelationInfo, error)
}

type Previewer interface {
	Preview(context.Context, string) (PreviewResult, error)
}

type PreviewResult struct {
	Columns   []string         `json:"columns"`
	Rows      []map[string]any `json:"rows"`
	Truncated bool             `json:"truncated"`
	Bytes     int              `json:"bytes"`
}

type ToolContext struct {
	ProjectID      string
	ConversationID string
	RunID          string
	ToolCallID     string
}

type Tools struct {
	sources     SourceCatalog
	connections ConnectionCatalog
	previewer   Previewer
	approvals   *ApprovalManager
}

func NewTools(sources SourceCatalog, connectionCatalog ConnectionCatalog, previewer Previewer, approvals *ApprovalManager) *Tools {
	return &Tools{sources: sources, connections: connectionCatalog, previewer: previewer, approvals: approvals}
}

func ToolSpecs() []ToolSpec {
	object := func(properties map[string]any, required ...string) map[string]any {
		return map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false}
	}
	stringProperty := map[string]any{"type": "string"}
	return []ToolSpec{
		{Name: "list_project_sources", Description: "List local tables and query results in the active project.", InputSchema: object(map[string]any{})},
		{Name: "list_connections", Description: "List sanitized database connections attached to the active project.", InputSchema: object(map[string]any{})},
		{Name: "list_schemas", Description: "List schemas for one connected project database.", InputSchema: object(map[string]any{"connectionId": stringProperty}, "connectionId")},
		{Name: "list_relations", Description: "List a bounded page of relations in a project connection schema.", InputSchema: object(map[string]any{"connectionId": stringProperty, "schema": stringProperty, "offset": map[string]any{"type": "integer", "minimum": 0}, "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": maxRelationPage}}, "connectionId", "schema"), DeferLoading: true},
		{Name: "describe_relation", Description: "Describe columns and ordering for a relation discovered with list_relations.", InputSchema: object(map[string]any{"relationId": stringProperty}, "relationId")},
		{Name: "validate_sql", Description: "Validate read-only DuckDB SQL against the active project scope.", InputSchema: object(map[string]any{"sql": stringProperty}, "sql")},
		{Name: "propose_sql", Description: "Return SQL after applying the active project's safety policy; this never executes it.", InputSchema: object(map[string]any{"sql": stringProperty}, "sql")},
		{Name: "preview_query", Description: "Run a read-only, non-materialized data preview capped by rows, bytes, and timeout. The host obtains one-time or conversation-scoped user authorization before execution.", InputSchema: object(map[string]any{"sql": stringProperty}, "sql")},
	}
}

func (t *Tools) Execute(ctx context.Context, call ToolContext, name string, raw json.RawMessage) (any, error) {
	if strings.TrimSpace(call.ProjectID) == "" {
		return nil, errors.New("tool call is not bound to a project")
	}
	input := make(map[string]any)
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &input); err != nil {
			return nil, models.NewError(models.CodeInvalidArgument, "Tool input is invalid", nil)
		}
	}
	switch name {
	case "list_project_sources":
		return t.listProjectSources(ctx, call.ProjectID)
	case "list_connections":
		return t.listConnections(ctx, call.ProjectID)
	case "list_schemas":
		return t.listSchemas(ctx, call.ProjectID, requiredString(input, "connectionId"))
	case "list_relations":
		return t.listRelations(ctx, call.ProjectID, input)
	case "describe_relation":
		return t.describeRelation(ctx, call.ProjectID, requiredString(input, "relationId"))
	case "validate_sql", "propose_sql":
		validated, err := t.validateSQL(ctx, call.ProjectID, requiredString(input, "sql"))
		if err != nil {
			return nil, err
		}
		return map[string]any{"valid": true, "sql": validated}, nil
	case "preview_query":
		return t.preview(ctx, call, input)
	default:
		return nil, models.NewError(models.CodeInvalidArgument, "AI tool is not registered", map[string]any{"tool": name})
	}
}

func (t *Tools) listProjectSources(ctx context.Context, projectID string) (any, error) {
	items, err := t.sources.ListSources(ctx, projectID)
	if err != nil {
		return nil, err
	}
	result := make([]map[string]any, 0, len(items))
	for _, source := range items {
		result = append(result, map[string]any{
			"id": source.ID, "name": source.DisplayName, "schema": source.Schema,
			"table": source.SQLName, "sourceType": source.SourceType, "rowCount": source.RowCount,
			"columns": source.Columns, "isEphemeral": source.IsEphemeral,
		})
	}
	return result, nil
}

func (t *Tools) listConnections(ctx context.Context, projectID string) (any, error) {
	items, err := t.connections.ListProjectConnections(ctx, projectID)
	if err != nil {
		return nil, err
	}
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		// Config, username, hosts, password state, and errors are all omitted.
		result = append(result, map[string]any{
			"id": item.ID, "name": item.Name, "provider": item.Kind,
			"catalog": item.CatalogName, "status": item.Status,
		})
	}
	return result, nil
}

func (t *Tools) listSchemas(ctx context.Context, projectID, connectionID string) (any, error) {
	if connectionID == "" {
		return nil, models.NewError(models.CodeInvalidArgument, "Connection ID is required", nil)
	}
	return t.connections.ListSchemas(ctx, projectID, connectionID)
}

func (t *Tools) listRelations(ctx context.Context, projectID string, input map[string]any) (any, error) {
	connectionID, schema := requiredString(input, "connectionId"), requiredString(input, "schema")
	if connectionID == "" || schema == "" {
		return nil, models.NewError(models.CodeInvalidArgument, "Connection ID and schema are required", nil)
	}
	offset := boundedInt(input["offset"], 0)
	limit := boundedInt(input["limit"], maxRelationPage)
	if offset < 0 || limit < 1 || limit > maxRelationPage {
		return nil, models.NewError(models.CodeInvalidArgument, "Relation page is outside the allowed range", map[string]any{"max": maxRelationPage})
	}
	items, err := t.connections.ListRelations(ctx, connections.ListRelationsRequest{ProjectID: projectID, ConnectionID: connectionID, Schema: schema})
	if err != nil {
		return nil, err
	}
	if offset > len(items) {
		offset = len(items)
	}
	end := offset + limit
	if end > len(items) {
		end = len(items)
	}
	page := items[offset:end]
	return map[string]any{"items": page, "offset": offset, "limit": limit, "hasMore": end < len(items)}, nil
}

func (t *Tools) describeRelation(ctx context.Context, projectID, relationID string) (any, error) {
	if relationID == "" {
		return nil, models.NewError(models.CodeInvalidArgument, "Relation ID is required", nil)
	}
	return t.connections.GetExternalRelation(ctx, projectID, relationID)
}

func (t *Tools) validateSQL(ctx context.Context, projectID, sqlText string) (string, error) {
	if strings.TrimSpace(sqlText) == "" {
		return "", models.NewError(models.CodeInvalidQuery, "SQL query is empty", nil)
	}
	scope, err := t.scope(ctx, projectID)
	if err != nil {
		return "", err
	}
	return ValidateProjectSQL(sqlText, scope)
}

func (t *Tools) scope(ctx context.Context, projectID string) (SQLScope, error) {
	sources, err := t.sources.ListSources(ctx, projectID)
	if err != nil {
		return SQLScope{}, err
	}
	connectionList, err := t.connections.ListProjectConnections(ctx, projectID)
	if err != nil {
		return SQLScope{}, err
	}
	scope := SQLScope{Catalogs: make(map[string]bool), LocalTables: make(map[string]bool), ResultTables: make(map[string]bool)}
	for _, source := range sources {
		if source.Schema == "result" {
			scope.ResultTables[source.SQLName] = true
		} else if source.Schema == "data" {
			scope.LocalTables[source.SQLName] = true
		}
	}
	for _, connection := range connectionList {
		scope.Catalogs[connection.CatalogName] = true
	}
	return scope, nil
}

func (t *Tools) preview(ctx context.Context, call ToolContext, input map[string]any) (any, error) {
	if t.previewer == nil || t.approvals == nil {
		return nil, errors.New("query preview is unavailable")
	}
	sqlText, err := t.validateSQL(ctx, call.ProjectID, requiredString(input, "sql"))
	if err != nil {
		return nil, err
	}
	approvalID, err := models.NewID()
	if err != nil {
		return nil, errors.New("could not create approval request")
	}
	approvalCtx, cancelApproval := context.WithTimeout(ctx, approvalTimeout)
	defer cancelApproval()
	err = t.approvals.Request(approvalCtx, ApprovalRequest{
		ID: approvalID, ProjectID: call.ProjectID, ConversationID: call.ConversationID,
		RunID: call.RunID, ToolCallID: call.ToolCallID, Tool: "preview_query",
		Summary: "Allow the assistant to run a read-only preview (up to 100 rows)?",
		Input:   map[string]any{"sql": sqlText}, CreatedAt: time.Now().UTC(),
	})
	if err != nil {
		return nil, err
	}
	previewCtx, cancelPreview := context.WithTimeout(ctx, maxToolTimeout)
	defer cancelPreview()
	return t.previewer.Preview(previewCtx, sqlText)
}

func requiredString(input map[string]any, key string) string {
	value, _ := input[key].(string)
	return strings.TrimSpace(value)
}

func boundedInt(value any, fallback int) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case json.Number:
		parsed, _ := typed.Int64()
		return int(parsed)
	default:
		return fallback
	}
}

type reservedConnection interface {
	WithConn(context.Context, func(*sql.Conn) error) error
}

type DuckDBPreviewer struct {
	db      *database.DB
	session reservedConnection
}

func NewDuckDBPreviewer(db *database.DB, session reservedConnection) *DuckDBPreviewer {
	return &DuckDBPreviewer{db: db, session: session}
}

func (p *DuckDBPreviewer) Preview(ctx context.Context, validatedSQL string) (PreviewResult, error) {
	queryText := "SELECT * FROM (\n" + validatedSQL + "\n) AS ai_preview LIMIT 101"
	var result PreviewResult
	run := func(queryer interface {
		ExecContext(context.Context, string, ...any) (sql.Result, error)
		QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	}) error {
		if _, err := queryer.ExecContext(ctx, "SET search_path = 'data,result,main'"); err != nil {
			return err
		}
		rows, err := queryer.QueryContext(ctx, queryText)
		if err != nil {
			return err
		}
		result, err = scanPreview(rows)
		return err
	}
	var err error
	if p.session != nil {
		err = p.session.WithConn(ctx, func(conn *sql.Conn) error { return run(conn) })
	} else if p.db != nil {
		err = run(p.db.SQL())
	} else {
		err = errors.New("DuckDB preview is unavailable")
	}
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return PreviewResult{}, models.NewError(models.CodeCancelled, "Query preview exceeded the time limit", map[string]any{"timeoutSeconds": int(maxToolTimeout.Seconds())})
		}
		return PreviewResult{}, models.NewError(models.CodeInvalidQuery, "Query preview could not be executed", nil)
	}
	return result, nil
}

func scanPreview(rows *sql.Rows) (PreviewResult, error) {
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return PreviewResult{}, err
	}
	result := PreviewResult{Columns: columns, Rows: make([]map[string]any, 0)}
	encodedColumns, err := json.Marshal(columns)
	if err != nil {
		return PreviewResult{}, err
	}
	// Reserve a small fixed envelope for keys, booleans, and counters so the
	// complete JSON tool output remains under maxToolBytes.
	result.Bytes = len(encodedColumns) + 1024
	if result.Bytes > maxToolBytes {
		return PreviewResult{}, errors.New("preview column metadata exceeds the byte limit")
	}
	for rows.Next() {
		values := make([]any, len(columns))
		destinations := make([]any, len(columns))
		for i := range values {
			destinations[i] = &values[i]
		}
		if err := rows.Scan(destinations...); err != nil {
			return PreviewResult{}, err
		}
		if len(result.Rows) >= maxToolRows {
			result.Truncated = true
			break
		}
		row := make(map[string]any, len(columns))
		for i, column := range columns {
			row[column] = boundedPreviewValue(database.SerializeValue(values[i]))
		}
		encoded, err := json.Marshal(row)
		if err != nil {
			return PreviewResult{}, err
		}
		if result.Bytes+len(encoded)+1 > maxToolBytes {
			result.Truncated = true
			break
		}
		result.Bytes += len(encoded) + 1
		result.Rows = append(result.Rows, row)
	}
	if err := rows.Err(); err != nil {
		return PreviewResult{}, fmt.Errorf("read preview rows: %w", err)
	}
	return result, nil
}

func boundedPreviewValue(value any) any {
	const maxCellBytes = 16 * 1024
	if text, ok := value.(string); ok && len(text) > maxCellBytes {
		return text[:maxCellBytes] + "… [truncated]"
	}
	encoded, err := json.Marshal(value)
	if err == nil && len(encoded) > maxCellBytes {
		return fmt.Sprintf("[value truncated: %d bytes]", len(encoded))
	}
	return value
}
