// Package importers previews and atomically materializes local tabular files.
package importers

import "ducs-table/internal/models"

type FileType string

const (
	FileCSV    FileType = "csv"
	FileTSV    FileType = "tsv"
	FileJSON   FileType = "json"
	FileJSONL  FileType = "jsonl"
	FileNDJSON FileType = "ndjson"
	FileXLSX   FileType = "xlsx"
)

type FileInfo struct {
	Path string   `json:"path"`
	Name string   `json:"name"`
	Type FileType `json:"type"`
	Size int64    `json:"size"`
}

// Options are passed only as bound values to trusted DuckDB reader functions.
type Options struct {
	Delimiter    string `json:"delimiter,omitempty"`
	Header       *bool  `json:"header,omitempty"`
	AllVarchar   bool   `json:"allVarchar,omitempty"`
	IgnoreErrors bool   `json:"ignoreErrors,omitempty"`
	SampleSize   int64  `json:"sampleSize,omitempty"`
}

type PreviewRequest struct {
	Path    string  `json:"path"`
	Options Options `json:"options"`
	Sheet   string  `json:"sheet,omitempty"`
	Limit   int     `json:"limit"`
}

type PreviewResult struct {
	File    FileInfo            `json:"file"`
	Sheets  []string            `json:"sheets,omitempty"`
	Sheet   string              `json:"sheet,omitempty"`
	Columns []models.ColumnInfo `json:"columns"`
	Rows    []map[string]any    `json:"rows"`
}

type MaterializeRequest struct {
	ProjectID   string  `json:"projectId"`
	ID          string  `json:"id,omitempty"`
	Path        string  `json:"path"`
	DisplayName string  `json:"displayName,omitempty"`
	SQLName     string  `json:"sqlName,omitempty"`
	Sheet       string  `json:"sheet,omitempty"`
	Options     Options `json:"options"`
}
