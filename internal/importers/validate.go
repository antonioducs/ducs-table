package importers

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"ducs-table/internal/models"

	"github.com/xuri/excelize/v2"
)

// ValidateFile checks type, metadata, regular-file status, readability, and
// non-zero size without modifying or loading the source.
func ValidateFile(path string) (FileInfo, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return FileInfo{}, models.NewError(models.CodeInvalidArgument, "A source file path is required", nil)
	}
	fileType, err := fileTypeForPath(path)
	if err != nil {
		return FileInfo{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return FileInfo{}, models.WrapError(models.CodeNotFound, "Source file was not found", err, nil)
		}
		return FileInfo{}, models.WrapError(models.CodeIO, "Could not inspect source file", err, nil)
	}
	if !info.Mode().IsRegular() {
		return FileInfo{}, models.NewError(models.CodeInvalidArgument, "Source path must be a regular file", nil)
	}
	if info.Size() <= 0 {
		return FileInfo{}, models.NewError(models.CodeInvalidArgument, "Source file is empty", map[string]any{"size": info.Size()})
	}
	file, err := os.Open(path)
	if err != nil {
		return FileInfo{}, models.WrapError(models.CodeIO, "Source file is not readable", err, nil)
	}
	var probe [1]byte
	_, readErr := file.Read(probe[:])
	closeErr := file.Close()
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return FileInfo{}, models.WrapError(models.CodeIO, "Source file is not readable", readErr, nil)
	}
	if closeErr != nil {
		return FileInfo{}, models.WrapError(models.CodeIO, "Could not close source file", closeErr, nil)
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return FileInfo{}, models.WrapError(models.CodeIO, "Could not resolve source file path", err, nil)
	}
	return FileInfo{Path: filepath.Clean(absPath), Name: info.Name(), Type: fileType, Size: info.Size()}, nil
}

func fileTypeForPath(path string) (FileType, error) {
	extension := strings.ToLower(filepath.Ext(path))
	switch extension {
	case ".csv":
		return FileCSV, nil
	case ".tsv":
		return FileTSV, nil
	case ".json":
		return FileJSON, nil
	case ".jsonl":
		return FileJSONL, nil
	case ".ndjson":
		return FileNDJSON, nil
	case ".xlsx":
		return FileXLSX, nil
	case ".xls":
		return "", models.NewError(models.CodeXLSUnsupported, "Legacy .xls files are not supported; save the workbook as .xlsx", nil)
	default:
		return "", models.NewError(models.CodeUnsupportedFile, fmt.Sprintf("Unsupported file type %q", extension), map[string]any{
			"supported": []string{".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".xlsx"},
		})
	}
}

// ListSheets uses Excelize for local workbook metadata and never starts a
// DuckDB extension installation.
func ListSheets(path string) ([]string, error) {
	info, err := ValidateFile(path)
	if err != nil {
		return nil, err
	}
	if info.Type != FileXLSX {
		return nil, models.NewError(models.CodeInvalidArgument, "Sheet listing requires an .xlsx file", nil)
	}
	workbook, err := excelize.OpenFile(info.Path)
	if err != nil {
		return nil, models.WrapError(models.CodeIO, "Could not open workbook", err, nil)
	}
	sheets := append([]string(nil), workbook.GetSheetList()...)
	if err := workbook.Close(); err != nil {
		return nil, models.WrapError(models.CodeIO, "Could not close workbook", err, nil)
	}
	if len(sheets) == 0 {
		return nil, models.NewError(models.CodeInvalidArgument, "Workbook contains no worksheets", nil)
	}
	return sheets, nil
}

func selectSheet(path, requested string) ([]string, string, error) {
	sheets, err := ListSheets(path)
	if err != nil {
		return nil, "", err
	}
	if requested == "" {
		return sheets, sheets[0], nil
	}
	for _, sheet := range sheets {
		if sheet == requested {
			return sheets, requested, nil
		}
	}
	return nil, "", models.NewError(models.CodeInvalidArgument, "Worksheet was not found", map[string]any{"sheet": requested})
}
