package importers

import (
	"errors"
	"fmt"
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
	build := func(allVarchar bool) readerAttempt {
		parts := []string{"?"}
		args := []any{file.Path}
		if delimiter != "" {
			parts = append(parts, "delim = ?")
			args = append(args, delimiter)
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
	attempts := []readerAttempt{build(options.AllVarchar)}
	// Type inference can fail on mixed late rows. A varchar retry still streams
	// the file and preserves every field; ignore_errors remains user-controlled.
	if !options.AllVarchar {
		attempts = append(attempts, build(true))
	}
	return attempts, nil
}

func readerFailure(fileType FileType, err error) error {
	var appErr *models.AppError
	if errors.As(err, &appErr) {
		return appErr
	}
	return models.WrapError(models.CodeInvalidArgument, fmt.Sprintf("Could not read %s source", strings.ToUpper(string(fileType))), err, nil)
}
