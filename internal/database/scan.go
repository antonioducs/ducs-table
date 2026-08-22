package database

import (
	"database/sql"
	"fmt"
	"math"
	"math/big"
	"reflect"
	"strconv"
	"time"

	duckdb "github.com/duckdb/duckdb-go/v2"
)

const maxSafeJSONInteger = int64(1<<53 - 1)

// ScanRows consumes and closes rows, producing JSON-serializable maps.
func ScanRows(rows *sql.Rows) ([]map[string]any, error) {
	defer rows.Close()
	columnNames, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	result := make([]map[string]any, 0)
	for rows.Next() {
		values := make([]any, len(columnNames))
		destinations := make([]any, len(values))
		for i := range values {
			destinations[i] = &values[i]
		}
		if err := rows.Scan(destinations...); err != nil {
			return nil, err
		}
		row := make(map[string]any, len(columnNames))
		for i, name := range columnNames {
			row[name] = SerializeValue(values[i])
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

// SerializeValue converts DuckDB driver values into values that encoding/json
// can represent without losing large integer or decimal precision.
func SerializeValue(value any) any {
	if value == nil {
		return nil
	}
	switch v := value.(type) {
	case time.Time:
		return v.Format(time.RFC3339Nano)
	case duckdb.Decimal:
		if v.Value == nil {
			return nil
		}
		return v.String()
	case *big.Int:
		if v == nil {
			return nil
		}
		return v.String()
	case duckdb.UUID:
		return v.String()
	case []byte:
		return fmt.Sprintf("<blob: %d bytes>", len(v))
	case duckdb.Interval:
		return fmt.Sprintf("%d months %d days %d microseconds", v.Months, v.Days, v.Micros)
	case duckdb.Union:
		return map[string]any{"tag": v.Tag, "value": SerializeValue(v.Value)}
	case string, bool, float32:
		return v
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return strconv.FormatFloat(v, 'g', -1, 64)
		}
		return v
	case int:
		return serializeSigned(int64(v))
	case int8:
		return v
	case int16:
		return v
	case int32:
		return v
	case int64:
		return serializeSigned(v)
	case uint:
		return serializeUnsigned(uint64(v))
	case uint8:
		return v
	case uint16:
		return v
	case uint32:
		return v
	case uint64:
		return serializeUnsigned(v)
	case duckdb.Map:
		out := make(map[string]any, len(v))
		for key, item := range v {
			out[fmt.Sprint(SerializeValue(key))] = SerializeValue(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			out[key] = SerializeValue(item)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = SerializeValue(item)
		}
		return out
	}

	rv := reflect.ValueOf(value)
	switch rv.Kind() {
	case reflect.Array, reflect.Slice:
		out := make([]any, rv.Len())
		for i := range rv.Len() {
			out[i] = SerializeValue(rv.Index(i).Interface())
		}
		return out
	case reflect.Map:
		out := make(map[string]any, rv.Len())
		iter := rv.MapRange()
		for iter.Next() {
			out[fmt.Sprint(SerializeValue(iter.Key().Interface()))] = SerializeValue(iter.Value().Interface())
		}
		return out
	}
	if stringer, ok := value.(fmt.Stringer); ok {
		return stringer.String()
	}
	return fmt.Sprint(value)
}

func serializeSigned(value int64) any {
	if value > maxSafeJSONInteger || value < -maxSafeJSONInteger {
		return strconv.FormatInt(value, 10)
	}
	return value
}

func serializeUnsigned(value uint64) any {
	if value > uint64(maxSafeJSONInteger) {
		return strconv.FormatUint(value, 10)
	}
	return value
}
