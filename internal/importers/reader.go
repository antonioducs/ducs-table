package importers

import (
	"strings"
	"unicode/utf8"

	"ducs-table/internal/models"
)

type readerAttempt struct {
	expression string
	args       []any
}

func buildReaderAttempts(file FileInfo, options Options, sheet string) ([]readerAttempt, error) {
	if options.SampleSize < 0 {
		return nil, models.NewError(models.CodeInvalidArgument, "Sample size cannot be negative", nil)
	}
	switch file.Type {
	case FileCSV, FileTSV:
		return csvReaderAttempts(file, options)
	case FileJSON:
		return []readerAttempt{{expression: `read_json_auto(?, format = ?)`, args: []any{file.Path, "auto"}}}, nil
	case FileJSONL, FileNDJSON:
		return []readerAttempt{{expression: `read_json_auto(?, format = ?)`, args: []any{file.Path, "newline_delimited"}}}, nil
	case FileXLSX:
		header := true
		if options.Header != nil {
			header = *options.Header
		}
		return []readerAttempt{{expression: `read_xlsx(?, sheet = ?, header = ?, ignore_errors = ?)`, args: []any{file.Path, sheet, header, options.IgnoreErrors}}}, nil
	default:
		return nil, models.NewError(models.CodeUnsupportedFile, "Unsupported source reader", nil)
	}
}

func csvReaderAttempts(file FileInfo, options Options) ([]readerAttempt, error) {
	delimiter := options.Delimiter
	if file.Type == FileTSV {
		delimiter = "\t"
	}
	if delimiter != "" && utf8.RuneCountInString(delimiter) != 1 {
		return nil, models.NewError(models.CodeInvalidArgument, "CSV delimiter must be exactly one character", nil)
	}
	build := func(allVarchar, rfcQuoting bool) readerAttempt {
		parts := []string{"?"}
		args := []any{file.Path}
		if delimiter != "" {
			parts = append(parts, "delim = ?")
			args = append(args, delimiter)
		}
		if rfcQuoting {
			parts = append(parts, "quote = ?", "escape = ?")
			args = append(args, `"`, `"`)
		}
		if options.Header != nil {
			parts = append(parts, "header = ?")
			args = append(args, *options.Header)
		}
		parts = append(parts, "all_varchar = ?", "ignore_errors = ?")
		args = append(args, allVarchar, options.IgnoreErrors)
		if options.SampleSize > 0 {
			parts = append(parts, "sample_size = ?")
			args = append(args, options.SampleSize)
		}
		return readerAttempt{expression: "read_csv_auto(" + strings.Join(parts, ", ") + ")", args: args}
	}
	var attempts []readerAttempt
	// The sniffer only samples the first rows: when no quoted field appears
	// there it settles on "no quote" and a later `"a,b"` splits into an extra
	// column. Sniffed attempts run first so detected quotes (e.g. ') still win;
	// RFC 4180 quoting (" escaped as "") is the fallback.
	for _, rfcQuoting := range []bool{false, true} {
		attempts = append(attempts, build(options.AllVarchar, rfcQuoting))
		// Type inference can fail on mixed late rows. A varchar retry still streams
		// the file and preserves every field; ignore_errors remains user-controlled.
		if !options.AllVarchar {
			attempts = append(attempts, build(true, rfcQuoting))
		}
	}
	return attempts, nil
}
