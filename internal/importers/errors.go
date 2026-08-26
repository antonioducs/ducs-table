package importers

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"ducs-table/internal/models"
)

const (
	stageValidation      = "validation"
	stagePreview         = "preview"
	stageRead            = "read"
	stageMaterialization = "materialization"
	stageCount           = "count"
	stagePublish         = "publish"
	stageCommit          = "commit"
)

type stagedError struct {
	stage string
	err   error
}

func (e *stagedError) Error() string { return e.err.Error() }
func (e *stagedError) Unwrap() error { return e.err }

func atStage(stage string, err error) error {
	if err == nil {
		return nil
	}
	return &stagedError{stage: stage, err: err}
}

func errorStage(err error, fallback string) string {
	var staged *stagedError
	if errors.As(err, &staged) && staged.stage != "" {
		return staged.stage
	}
	return fallback
}

func sourceTypeFromPath(path string) FileType {
	extension := strings.TrimPrefix(strings.ToLower(filepath.Ext(path)), ".")
	switch FileType(extension) {
	case FileCSV, FileTSV, FileJSON, FileJSONL, FileNDJSON, FileXLSX:
		return FileType(extension)
	default:
		return ""
	}
}

func sourceReadStage(fileType FileType, err error, fallback string) string {
	message := strings.ToLower(fmt.Sprint(err))
	markers := []string{
		"csv error", "json error", "malformed", "parse error", "parser error",
		"invalid encoding", "invalid unicode", "invalid input", "could not convert",
		"failed to cast", "expected number of columns", "unterminated", "delimiter",
		"maximum line size", "maximum object size",
	}
	for _, marker := range markers {
		if strings.Contains(message, marker) {
			return stageRead
		}
	}
	if fileType == FileCSV || fileType == FileTSV || fileType == FileJSON || fileType == FileJSONL || fileType == FileNDJSON {
		if strings.Contains(message, "reader") || strings.Contains(message, "sniff") {
			return stageRead
		}
	}
	return fallback
}

func importFailure(fileType FileType, stage string, err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return models.WrapError(models.CodeCancelled, "Import was cancelled", err, importDetails(fileType, stage, "Retry the import when you are ready"))
	}

	var existing *models.AppError
	if errors.As(err, &existing) && preserveImportError(existing.Code, stage) {
		details := copyDetails(existing.Details)
		mergeImportDetails(details, fileType, stage, suggestionFor(stage, fileType))
		return models.WrapError(existing.Code, existing.Message, err, details)
	}

	code, message := importFailurePresentation(stage, fileType)
	return models.WrapError(code, message, err, importDetails(fileType, stage, suggestionFor(stage, fileType)))
}

func preserveImportError(code, stage string) bool {
	if stage == stageValidation {
		return true
	}
	switch code {
	case models.CodeCancelled, models.CodeXLSXExtensionUnavailable, models.CodeUnsupportedFile, models.CodeXLSUnsupported:
		return true
	default:
		return false
	}
}

func importFailurePresentation(stage string, fileType FileType) (string, string) {
	source := strings.ToUpper(string(fileType))
	if source == "" {
		source = "source"
	}
	switch stage {
	case stagePreview:
		return models.CodeImportPreviewFailed, "The source preview could not be prepared"
	case stageRead:
		return models.CodeImportReadFailed, fmt.Sprintf("The %s source could not be parsed", source)
	case stageCount:
		return models.CodeImportCountFailed, "The imported rows could not be verified"
	case stagePublish:
		return models.CodeImportPublishFailed, "The imported table could not be published"
	case stageCommit:
		return models.CodeImportCommitFailed, "The import could not be committed"
	default:
		return models.CodeImportMaterializationFailed, "The source could not be materialized in DuckDB"
	}
}

func suggestionFor(stage string, fileType FileType) string {
	switch stage {
	case stageValidation:
		return "Check that the file still exists, is readable, and uses a supported format"
	case stagePreview:
		return "Retry the import; if it fails again, use the error reference shown below"
	case stageRead:
		if fileType == FileCSV || fileType == FileTSV {
			return "Check the delimiter and header options, or retry with all columns as text"
		}
		return "Check that the file is complete and uses the expected format"
	case stageCount, stagePublish, stageCommit, stageMaterialization:
		return "Retry the import; if it fails again, use the error reference shown below"
	default:
		return "Retry the import and use the error reference if the problem continues"
	}
}

func importDetails(fileType FileType, stage, suggestion string) map[string]any {
	details := make(map[string]any, 3)
	mergeImportDetails(details, fileType, stage, suggestion)
	return details
}

func mergeImportDetails(details map[string]any, fileType FileType, stage, suggestion string) {
	if stage != "" {
		details["stage"] = stage
	}
	if fileType != "" {
		details["sourceType"] = string(fileType)
	}
	if suggestion != "" {
		details["suggestion"] = suggestion
	}
}

func copyDetails(details map[string]any) map[string]any {
	result := make(map[string]any, len(details)+3)
	for key, value := range details {
		result[key] = value
	}
	return result
}
