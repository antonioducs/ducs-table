package grid

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"ducs-table/internal/database"
	"ducs-table/internal/models"
	"ducs-table/internal/workspace"
)

const (
	defaultLimit = 100
	maxLimit     = 5000
)

type Service struct {
	db        *database.DB
	workspace *workspace.Service
	external  ExternalResolver
}

func (s *Service) SetExternalResolver(resolver ExternalResolver) { s.external = resolver }

func New(db *database.DB, workspaces ...*workspace.Service) *Service {
	var ws *workspace.Service
	if len(workspaces) > 0 {
		ws = workspaces[0]
	}
	if ws == nil {
		ws = workspace.New(db)
	}
	return &Service{db: db, workspace: ws}
}

func (s *Service) Rows(ctx context.Context, request RowsRequest) (RowsResponse, error) {
	resource, err := normalizeResource(request.Resource, request.SourceID)
	if err != nil {
		return RowsResponse{}, err
	}
	limit := request.Limit
	if limit == 0 {
		limit = defaultLimit
	}
	built, err := s.BuildSelect(ctx, SelectRequest{
		Resource: resource, SourceID: request.SourceID, Columns: request.VisibleColumns,
		Sorts: request.Sorts, Filters: request.Filters,
		Offset: request.Offset, Limit: limit,
	}, true)
	if err != nil {
		return RowsResponse{}, err
	}
	values, err := s.ExecuteSelect(ctx, built)
	if err != nil {
		code := models.CodeDatabase
		message := "Could not load source rows"
		details := map[string]any{"sourceId": resource.SourceID}
		if resource.Kind == "external" {
			code = models.CodeConnectionFailed
			message = "The live relation could not be read. Reconnect its database and try again"
			details = map[string]any{"relationId": resource.RelationID}
		}
		return RowsResponse{}, models.NewError(code, message, details)
	}
	response := RowsResponse{Resource: resource, SourceID: resource.SourceID, Columns: built.Columns, Offset: request.Offset, Limit: limit, PagingStable: true}
	if resource.Kind == "external" {
		response.PagingStable = built.Relation.PagingStable
		response.HasMore = len(values) > limit
		if response.HasMore {
			values = values[:limit]
		}
		response.Rows = values
		return response, nil
	}
	total, err := s.CountRows(ctx, resource.SourceID, request.Filters)
	if err != nil {
		return RowsResponse{}, err
	}
	response.Rows = values
	response.TotalRows = &total
	response.HasMore = request.Offset+int64(len(values)) < total
	return response, nil
}

// GetRows is an alias convenient for a Wails binding.
func (s *Service) GetRows(ctx context.Context, request RowsRequest) (RowsResponse, error) {
	return s.Rows(ctx, request)
}

func (s *Service) CountRows(ctx context.Context, sourceID string, filters []Filter) (int64, error) {
	resolved, err := s.resolve(ctx, models.GridResourceRef{Kind: "source", SourceID: sourceID}, nil)
	if err != nil {
		return 0, err
	}
	where, args, err := buildWhere(filters, resolved.columnMap)
	if err != nil {
		return 0, err
	}
	query := "SELECT COUNT(*) FROM " + resolved.fromSQL + " AS t" + where
	var count int64
	if err := s.db.SQL().QueryRowContext(ctx, query, args...).Scan(&count); err != nil {
		return 0, models.WrapError(models.CodeDatabase, "Could not count source rows", err, map[string]any{"sourceId": sourceID})
	}
	return count, nil
}

// CountResource keeps remote counts explicit: live relations report unknown
// rather than issuing an expensive COUNT(*) behind the grid's back.
func (s *Service) CountResource(ctx context.Context, resource models.GridResourceRef, filters []Filter) (*int64, error) {
	resource, err := normalizeResource(resource, "")
	if err != nil {
		return nil, err
	}
	if resource.Kind == "external" {
		return nil, nil
	}
	count, err := s.CountRows(ctx, resource.SourceID, filters)
	if err != nil {
		return nil, err
	}
	return &count, nil
}

// BuildSelect constructs a controlled SELECT reusable by CSV export.
func (s *Service) BuildSelect(ctx context.Context, request SelectRequest, paginate bool) (BuiltSelect, error) {
	if request.Offset < 0 {
		return BuiltSelect{}, models.NewError(models.CodeInvalidArgument, "Row offset cannot be negative", nil)
	}
	if paginate {
		if request.Limit <= 0 || request.Limit > maxLimit {
			return BuiltSelect{}, models.NewError(models.CodeInvalidArgument, "Row limit is outside the allowed range", map[string]any{"min": 1, "max": maxLimit})
		}
	}
	resource, err := normalizeResource(request.Resource, request.SourceID)
	if err != nil {
		return BuiltSelect{}, err
	}
	resolved, err := s.resolve(ctx, resource, request.Columns)
	if err != nil {
		return BuiltSelect{}, err
	}
	where, args, err := buildWhere(request.Filters, resolved.columnMap)
	if err != nil {
		return BuiltSelect{}, err
	}
	selectColumns := make([]string, len(resolved.selected))
	for i, column := range resolved.selected {
		selectColumns[i] = "t." + database.QuoteIdentifier(column.Name)
	}
	query := "SELECT " + strings.Join(selectColumns, ", ") + " FROM " +
		resolved.fromSQL + " AS t" + where
	order, err := buildOrder(request.Sorts, resolved.columnMap, resolved.defaultOrder, resolved.useRowID)
	if err != nil {
		return BuiltSelect{}, err
	}
	query += order
	if paginate {
		fetchLimit := request.Limit
		if resource.Kind == "external" {
			fetchLimit++
		}
		// DuckDB 1.4.x can push a plain LIMIT into its PostgreSQL scanner, but
		// not the ORDER BY + LIMIT pair used for deterministic grid paging. Run
		// filter-free pages as a native PostgreSQL query so an indexed primary
		// key can return the first block without DuckDB scanning and sorting the
		// entire remote relation. Filtered pages retain the controlled generic
		// path because their DuckDB casts are not all PostgreSQL-compatible.
		if resolved.relation != nil && resolved.relation.Provider == "postgres" && len(request.Filters) == 0 {
			remoteFrom := database.QuoteQualified(resolved.relation.Schema, resolved.relation.Name)
			remoteSQL := "SELECT " + strings.Join(selectColumns, ", ") + " FROM " + remoteFrom + " AS t" + order +
				" LIMIT " + strconv.Itoa(fetchLimit) + " OFFSET " + strconv.FormatInt(request.Offset, 10)
			query = "SELECT * FROM postgres_query(?, ?)"
			args = []any{resolved.relation.Catalog, remoteSQL}
		} else {
			query += " LIMIT ? OFFSET ?"
			args = append(args, fetchLimit, request.Offset)
		}
	}
	built := BuiltSelect{SQL: query, Args: args, Source: resolved.source, Resource: resource, Columns: resolved.selected}
	if resolved.relation != nil {
		relation := *resolved.relation
		built.Relation = &relation
	}
	return built, nil
}

type resolvedRelation struct {
	resource     models.GridResourceRef
	fromSQL      string
	source       models.SourceInfo
	relation     *models.ExternalRelationInfo
	selected     []models.ColumnInfo
	columnMap    map[string]models.ColumnInfo
	defaultOrder []string
	useRowID     bool
}

func (s *Service) resolve(ctx context.Context, resource models.GridResourceRef, requested []string) (resolvedRelation, error) {
	var resolved resolvedRelation
	resolved.resource = resource
	var columns []models.ColumnInfo
	if resource.Kind == "source" {
		source, err := s.workspace.GetSource(ctx, resource.SourceID)
		if err != nil {
			return resolvedRelation{}, err
		}
		if source.Schema != "data" && source.Schema != "result" {
			return resolvedRelation{}, models.NewError(models.CodeInvalidArgument, "Source schema is not queryable", nil)
		}
		resolved.source = source
		resolved.fromSQL = database.QuoteQualified(source.Schema, source.SQLName)
		resolved.useRowID = true
		columns = source.Columns
	} else {
		if s.external == nil {
			return resolvedRelation{}, models.NewError(models.CodeConnectionNotConnected, "External database services are unavailable", nil)
		}
		relation, err := s.external.ResolveExternal(ctx, resource.RelationID)
		if err != nil {
			return resolvedRelation{}, err
		}
		resolved.relation = &relation
		resolved.fromSQL = relation.QualifiedName
		resolved.defaultOrder = append([]string(nil), relation.DefaultOrder...)
		columns = relation.Columns
	}
	columnMap := make(map[string]models.ColumnInfo, len(columns))
	for _, column := range columns {
		columnMap[column.Name] = column
	}
	if len(columns) == 0 {
		return resolvedRelation{}, models.NewError(models.CodeInvalidArgument, "Relation has no columns", nil)
	}
	if len(requested) == 0 {
		resolved.selected = append([]models.ColumnInfo(nil), columns...)
		resolved.columnMap = columnMap
		return resolved, nil
	}
	seen := make(map[string]bool, len(requested))
	selected := make([]models.ColumnInfo, 0, len(requested))
	for _, name := range requested {
		column, ok := columnMap[name]
		if !ok {
			return resolvedRelation{}, badColumn(name)
		}
		if seen[name] {
			return resolvedRelation{}, models.NewError(models.CodeInvalidArgument, "Visible columns contain a duplicate", map[string]any{"column": name})
		}
		seen[name] = true
		selected = append(selected, column)
	}
	resolved.selected = selected
	resolved.columnMap = columnMap
	return resolved, nil
}

func buildOrder(sorts []Sort, columns map[string]models.ColumnInfo, defaultOrder []string, useRowID bool) (string, error) {
	parts := make([]string, 0, len(sorts)+len(defaultOrder)+1)
	seen := make(map[string]bool, len(sorts))
	for _, sortSpec := range sorts {
		if _, ok := columns[sortSpec.Column]; !ok {
			return "", badColumn(sortSpec.Column)
		}
		if seen[sortSpec.Column] {
			return "", models.NewError(models.CodeInvalidArgument, "Sort column is duplicated", map[string]any{"column": sortSpec.Column})
		}
		seen[sortSpec.Column] = true
		direction := strings.ToUpper(strings.TrimSpace(sortSpec.Direction))
		if direction == "" {
			direction = "ASC"
		}
		if direction != "ASC" && direction != "DESC" {
			return "", models.NewError(models.CodeInvalidArgument, "Sort direction must be asc or desc", map[string]any{"direction": sortSpec.Direction})
		}
		parts = append(parts, "t."+database.QuoteIdentifier(sortSpec.Column)+" "+direction+" NULLS LAST")
	}
	for _, name := range defaultOrder {
		if seen[name] {
			continue
		}
		if _, ok := columns[name]; !ok {
			continue
		}
		seen[name] = true
		parts = append(parts, "t."+database.QuoteIdentifier(name)+" ASC NULLS LAST")
	}
	if useRowID {
		parts = append(parts, "t.rowid ASC")
	}
	if len(parts) == 0 {
		return "", nil
	}
	return " ORDER BY " + strings.Join(parts, ", "), nil
}

func normalizeResource(resource models.GridResourceRef, legacySourceID string) (models.GridResourceRef, error) {
	if resource.Kind == "" && legacySourceID != "" {
		resource = models.GridResourceRef{Kind: "source", SourceID: legacySourceID}
	}
	if resource.Kind == "source" && resource.SourceID != "" && resource.RelationID == "" {
		return resource, nil
	}
	if resource.Kind == "external" && resource.RelationID != "" && resource.SourceID == "" {
		return resource, nil
	}
	return models.GridResourceRef{}, models.NewError(models.CodeInvalidArgument, "Grid resource reference is invalid", nil)
}

// ExecuteSelect consumes rows while the federated session lock is held for a
// live relation. Local datasets continue to use the regular pool.
func (s *Service) ExecuteSelect(ctx context.Context, built BuiltSelect) ([]map[string]any, error) {
	if built.Resource.Kind != "external" {
		rows, err := s.db.SQL().QueryContext(ctx, built.SQL, built.Args...)
		if err != nil {
			return nil, err
		}
		return database.ScanRows(rows)
	}
	if s.external == nil {
		return nil, models.NewError(models.CodeConnectionNotConnected, "External database services are unavailable", nil)
	}
	var values []map[string]any
	err := s.external.WithFederatedConn(ctx, func(conn *sql.Conn) error {
		rows, queryErr := conn.QueryContext(ctx, built.SQL, built.Args...)
		if queryErr != nil {
			return queryErr
		}
		values, queryErr = database.ScanRows(rows)
		return queryErr
	})
	return values, err
}

func (s *Service) WithResourceConn(ctx context.Context, resource models.GridResourceRef, fn func(*sql.Conn) error) error {
	resource, err := normalizeResource(resource, "")
	if err != nil {
		return err
	}
	if resource.Kind == "external" {
		if s.external == nil {
			return models.NewError(models.CodeConnectionNotConnected, "External database services are unavailable", nil)
		}
		return s.external.WithFederatedConn(ctx, fn)
	}
	conn, err := s.db.SQL().Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	return fn(conn)
}

func buildWhere(filters []Filter, columns map[string]models.ColumnInfo) (string, []any, error) {
	parts := make([]string, 0, len(filters))
	args := make([]any, 0, len(filters)*2)
	for _, filter := range filters {
		column, ok := columns[filter.Column]
		if !ok {
			return "", nil, badColumn(filter.Column)
		}
		expression, values, err := buildFilter(filter, column)
		if err != nil {
			return "", nil, err
		}
		parts = append(parts, expression)
		args = append(args, values...)
	}
	if len(parts) == 0 {
		return "", nil, nil
	}
	return " WHERE " + strings.Join(parts, " AND "), args, nil
}

func buildFilter(filter Filter, column models.ColumnInfo) (string, []any, error) {
	operator := canonical(filter.Operator)
	typeName := strings.ToLower(strings.TrimSpace(filter.Type))
	category := columnCategory(column.Type)
	if typeName == "" {
		typeName = category
	}
	if typeName == "bool" {
		typeName = "boolean"
	}
	if typeName != category {
		return "", nil, models.NewError(models.CodeInvalidArgument, "Filter type does not match the source column", map[string]any{
			"column": column.Name, "filterType": filter.Type, "columnType": column.Type,
		})
	}
	columnSQL := "t." + database.QuoteIdentifier(column.Name)
	switch typeName {
	case "text":
		return textFilter(columnSQL, operator, filter.Value)
	case "number":
		return comparableFilter(columnSQL, operator, filter.Value, filter.ValueTo, numericCast(column.Type), true)
	case "date":
		return comparableFilter(columnSQL, operator, filter.Value, filter.ValueTo, dateCast(column.Type), false)
	case "boolean":
		return booleanFilter(columnSQL, operator, filter.Value)
	default:
		return "", nil, models.NewError(models.CodeInvalidArgument, "Column type is not filterable", map[string]any{"column": column.Name, "columnType": column.Type})
	}
}

func textFilter(column, operator string, value any) (string, []any, error) {
	switch operator {
	case "blank":
		return "(" + column + " IS NULL OR CAST(" + column + " AS VARCHAR) = '')", nil, nil
	case "notblank":
		return "(" + column + " IS NOT NULL AND CAST(" + column + " AS VARCHAR) <> '')", nil, nil
	}
	text, ok := value.(string)
	if !ok {
		return "", nil, missingValue("Text filter value must be a string")
	}
	cast := "CAST(" + column + " AS VARCHAR)"
	switch operator {
	case "contains":
		return cast + " ILIKE ? ESCAPE '\\'", []any{"%" + escapeLike(text) + "%"}, nil
	case "notcontains":
		return cast + " NOT ILIKE ? ESCAPE '\\'", []any{"%" + escapeLike(text) + "%"}, nil
	case "equals", "equal", "=":
		return cast + " = ?", []any{text}, nil
	case "notequals", "notequal", "!=", "<>":
		return cast + " <> ?", []any{text}, nil
	case "startswith", "starts":
		return cast + " ILIKE ? ESCAPE '\\'", []any{escapeLike(text) + "%"}, nil
	case "endswith", "ends":
		return cast + " ILIKE ? ESCAPE '\\'", []any{"%" + escapeLike(text)}, nil
	default:
		return "", nil, badOperator(operator, "text")
	}
}

var numericPattern = regexp.MustCompile(`^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$`)

func comparableFilter(column, operator string, value, valueTo any, castType string, numeric bool) (string, []any, error) {
	switch operator {
	case "blank":
		return column + " IS NULL", nil, nil
	case "notblank":
		return column + " IS NOT NULL", nil, nil
	}
	first, err := comparableValue(value, numeric)
	if err != nil {
		return "", nil, err
	}
	placeholder := "CAST(? AS " + castType + ")"
	comparison := map[string]string{
		"equals": "=", "equal": "=", "=": "=", "notequals": "<>", "notequal": "<>", "!=": "<>", "<>": "<>",
		"greaterthan": ">", "gt": ">", ">": ">", "greaterthanorequal": ">=", "gte": ">=", ">=": ">=",
		"lessthan": "<", "lt": "<", "<": "<", "lessthanorequal": "<=", "lte": "<=", "<=": "<=",
	}
	if sqlOperator, ok := comparison[operator]; ok {
		return column + " " + sqlOperator + " " + placeholder, []any{first}, nil
	}
	if operator == "range" || operator == "inrange" || operator == "between" {
		second, err := comparableValue(valueTo, numeric)
		if err != nil {
			return "", nil, err
		}
		return column + " BETWEEN " + placeholder + " AND " + placeholder, []any{first, second}, nil
	}
	return "", nil, badOperator(operator, "number/date")
}

func comparableValue(value any, numeric bool) (any, error) {
	if value == nil {
		return nil, missingValue("Filter value is required")
	}
	if !numeric {
		text, ok := value.(string)
		if !ok || strings.TrimSpace(text) == "" {
			return nil, missingValue("Date filter value must be a string")
		}
		return text, nil
	}
	switch v := value.(type) {
	case string:
		if !numericPattern.MatchString(strings.TrimSpace(v)) {
			return nil, missingValue("Number filter value is invalid")
		}
		return strings.TrimSpace(v), nil
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return nil, missingValue("Number filter value is invalid")
		}
		return strconv.FormatFloat(v, 'g', -1, 64), nil
	case float32:
		return strconv.FormatFloat(float64(v), 'g', -1, 32), nil
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return fmt.Sprint(v), nil
	default:
		return nil, missingValue("Number filter value is invalid")
	}
}

func booleanFilter(column, operator string, value any) (string, []any, error) {
	switch operator {
	case "blank":
		return column + " IS NULL", nil, nil
	case "notblank":
		return column + " IS NOT NULL", nil, nil
	case "true":
		return column + " = ?", []any{true}, nil
	case "false":
		return column + " = ?", []any{false}, nil
	case "equals", "equal", "=", "notequals", "notequal", "!=", "<>":
		boolean, err := parseBoolean(value)
		if err != nil {
			return "", nil, err
		}
		op := "="
		if operator == "notequals" || operator == "notequal" || operator == "!=" || operator == "<>" {
			op = "<>"
		}
		return column + " " + op + " ?", []any{boolean}, nil
	default:
		return "", nil, badOperator(operator, "boolean")
	}
}

func parseBoolean(value any) (bool, error) {
	if boolean, ok := value.(bool); ok {
		return boolean, nil
	}
	if text, ok := value.(string); ok {
		boolean, err := strconv.ParseBool(strings.TrimSpace(text))
		if err == nil {
			return boolean, nil
		}
	}
	return false, missingValue("Boolean filter value is invalid")
}

func columnCategory(dataType string) string {
	typeName := strings.ToUpper(dataType)
	switch {
	case strings.Contains(typeName, "BOOL"):
		return "boolean"
	case strings.Contains(typeName, "DATE"), strings.Contains(typeName, "TIME"):
		return "date"
	case strings.Contains(typeName, "INT"), strings.Contains(typeName, "DECIMAL"), strings.Contains(typeName, "NUMERIC"),
		strings.Contains(typeName, "DOUBLE"), strings.Contains(typeName, "FLOAT"), strings.Contains(typeName, "REAL"):
		return "number"
	case strings.Contains(typeName, "CHAR"), strings.Contains(typeName, "TEXT"), strings.Contains(typeName, "STRING"),
		strings.Contains(typeName, "UUID"), strings.Contains(typeName, "ENUM"):
		return "text"
	default:
		return ""
	}
}

func dateCast(dataType string) string {
	typeName := strings.ToUpper(dataType)
	switch {
	case strings.Contains(typeName, "TIMESTAMP WITH TIME ZONE"), strings.Contains(typeName, "TIMESTAMPTZ"):
		return "TIMESTAMPTZ"
	case strings.Contains(typeName, "TIMESTAMP"):
		return "TIMESTAMP"
	case strings.Contains(typeName, "DATE"):
		return "DATE"
	case strings.Contains(typeName, "TIME WITH TIME ZONE"), strings.Contains(typeName, "TIMETZ"):
		return "TIMETZ"
	default:
		return "TIME"
	}
}

var decimalTypePattern = regexp.MustCompile(`^(?:DECIMAL|NUMERIC)\([0-9]+,[0-9]+\)$`)

// numericCast returns only a fixed allowlisted DuckDB type spelling derived
// from catalog metadata; user input can never become part of the SQL type.
func numericCast(dataType string) string {
	typeName := strings.ToUpper(strings.TrimSpace(dataType))
	switch {
	case decimalTypePattern.MatchString(typeName):
		return typeName
	case strings.Contains(typeName, "DOUBLE"), strings.Contains(typeName, "FLOAT"), strings.Contains(typeName, "REAL"):
		return "DOUBLE"
	case strings.Contains(typeName, "UHUGEINT"), strings.Contains(typeName, "UBIGINT"), strings.Contains(typeName, "UINTEGER"),
		strings.Contains(typeName, "USMALLINT"), strings.Contains(typeName, "UTINYINT"):
		return "UHUGEINT"
	case strings.Contains(typeName, "INT"):
		return "HUGEINT"
	default:
		return "DECIMAL(38,18)"
	}
}

func canonical(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	replacer := strings.NewReplacer(" ", "", "_", "", "-", "")
	return replacer.Replace(value)
}

func escapeLike(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `%`, `\%`)
	return strings.ReplaceAll(value, `_`, `\_`)
}

func badColumn(name string) error {
	return models.NewError(models.CodeColumnNotFound, "Column was not found in the source", map[string]any{"column": name})
}

func badOperator(operator, filterType string) error {
	return models.NewError(models.CodeInvalidArgument, "Filter operator is not supported", map[string]any{"operator": operator, "filterType": filterType})
}

func missingValue(message string) error {
	return models.NewError(models.CodeInvalidArgument, message, nil)
}
