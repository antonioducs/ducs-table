package grid

import (
	"context"
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
}

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
	limit := request.Limit
	if limit == 0 {
		limit = defaultLimit
	}
	built, err := s.BuildSelect(ctx, SelectRequest{
		SourceID: request.SourceID, Columns: request.VisibleColumns,
		Sorts: request.Sorts, Filters: request.Filters,
		Offset: request.Offset, Limit: limit,
	}, true)
	if err != nil {
		return RowsResponse{}, err
	}
	rows, err := s.db.SQL().QueryContext(ctx, built.SQL, built.Args...)
	if err != nil {
		return RowsResponse{}, models.WrapError(models.CodeDatabase, "Could not load source rows", err, map[string]any{"sourceId": request.SourceID})
	}
	values, err := database.ScanRows(rows)
	if err != nil {
		return RowsResponse{}, models.WrapError(models.CodeDatabase, "Could not read source rows", err, map[string]any{"sourceId": request.SourceID})
	}
	total, err := s.CountRows(ctx, request.SourceID, request.Filters)
	if err != nil {
		return RowsResponse{}, err
	}
	return RowsResponse{
		SourceID: request.SourceID, Columns: built.Columns, Rows: values,
		Offset: request.Offset, Limit: limit, TotalRows: total,
	}, nil
}

// GetRows is an alias convenient for a Wails binding.
func (s *Service) GetRows(ctx context.Context, request RowsRequest) (RowsResponse, error) {
	return s.Rows(ctx, request)
}

func (s *Service) CountRows(ctx context.Context, sourceID string, filters []Filter) (int64, error) {
	source, columns, columnMap, err := s.resolve(ctx, sourceID, nil)
	if err != nil {
		return 0, err
	}
	_ = columns
	where, args, err := buildWhere(filters, columnMap)
	if err != nil {
		return 0, err
	}
	query := "SELECT COUNT(*) FROM " + database.QuoteQualified(source.Schema, source.SQLName) + " AS t" + where
	var count int64
	if err := s.db.SQL().QueryRowContext(ctx, query, args...).Scan(&count); err != nil {
		return 0, models.WrapError(models.CodeDatabase, "Could not count source rows", err, map[string]any{"sourceId": sourceID})
	}
	return count, nil
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
	source, selected, columnMap, err := s.resolve(ctx, request.SourceID, request.Columns)
	if err != nil {
		return BuiltSelect{}, err
	}
	where, args, err := buildWhere(request.Filters, columnMap)
	if err != nil {
		return BuiltSelect{}, err
	}
	selectColumns := make([]string, len(selected))
	for i, column := range selected {
		selectColumns[i] = "t." + database.QuoteIdentifier(column.Name)
	}
	query := "SELECT " + strings.Join(selectColumns, ", ") + " FROM " +
		database.QuoteQualified(source.Schema, source.SQLName) + " AS t" + where
	order, err := buildOrder(request.Sorts, columnMap)
	if err != nil {
		return BuiltSelect{}, err
	}
	query += order
	if paginate {
		query += " LIMIT ? OFFSET ?"
		args = append(args, request.Limit, request.Offset)
	}
	return BuiltSelect{SQL: query, Args: args, Source: source, Columns: selected}, nil
}

func (s *Service) resolve(ctx context.Context, sourceID string, requested []string) (models.SourceInfo, []models.ColumnInfo, map[string]models.ColumnInfo, error) {
	source, err := s.workspace.GetSource(ctx, sourceID)
	if err != nil {
		return models.SourceInfo{}, nil, nil, err
	}
	if source.Schema != "data" && source.Schema != "result" {
		return models.SourceInfo{}, nil, nil, models.NewError(models.CodeInvalidArgument, "Source schema is not queryable", nil)
	}
	columnMap := make(map[string]models.ColumnInfo, len(source.Columns))
	for _, column := range source.Columns {
		columnMap[column.Name] = column
	}
	if len(source.Columns) == 0 {
		return models.SourceInfo{}, nil, nil, models.NewError(models.CodeInvalidArgument, "Source has no columns", map[string]any{"sourceId": sourceID})
	}
	if len(requested) == 0 {
		return source, append([]models.ColumnInfo(nil), source.Columns...), columnMap, nil
	}
	seen := make(map[string]bool, len(requested))
	selected := make([]models.ColumnInfo, 0, len(requested))
	for _, name := range requested {
		column, ok := columnMap[name]
		if !ok {
			return models.SourceInfo{}, nil, nil, badColumn(name)
		}
		if seen[name] {
			return models.SourceInfo{}, nil, nil, models.NewError(models.CodeInvalidArgument, "Visible columns contain a duplicate", map[string]any{"column": name})
		}
		seen[name] = true
		selected = append(selected, column)
	}
	return source, selected, columnMap, nil
}

func buildOrder(sorts []Sort, columns map[string]models.ColumnInfo) (string, error) {
	parts := make([]string, 0, len(sorts)+1)
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
	// Physical rowid is never selected. It gives deterministic pages and breaks
	// ties for every user sort.
	parts = append(parts, "t.rowid ASC")
	return " ORDER BY " + strings.Join(parts, ", "), nil
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
