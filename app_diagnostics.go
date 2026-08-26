package main

import (
	"os"
	"path/filepath"
	"time"

	"ducs-table/internal/jobs"
	"ducs-table/internal/models"
)

type importDiagnostic struct {
	ProjectID  string
	SourceID   string
	Path       string
	SourceType string
	Size       int64
	StartedAt  time.Time
}

func (a *App) logImportStarted(diagnostic importDiagnostic) {
	if a.logger == nil {
		return
	}
	a.logger.Info("import_started",
		"project_id", diagnostic.ProjectID,
		"source_id", diagnostic.SourceID,
		"source_name", filepath.Base(diagnostic.Path),
		"source_type", diagnostic.SourceType,
		"source_size_bytes", diagnostic.Size,
		"stage", "preview",
	)
}

func (a *App) logImportSucceeded(diagnostic importDiagnostic, rowCount int64, columnCount int) {
	if a.logger == nil {
		return
	}
	a.logger.Info("import_succeeded",
		"project_id", diagnostic.ProjectID,
		"source_id", diagnostic.SourceID,
		"source_name", filepath.Base(diagnostic.Path),
		"source_type", diagnostic.SourceType,
		"source_size_bytes", diagnostic.Size,
		"row_count", rowCount,
		"column_count", columnCount,
		"duration_ms", elapsedMilliseconds(diagnostic.StartedAt),
	)
}

func (a *App) logQueuedImportCancelled(snapshot jobs.Snapshot) {
	if a.logger == nil {
		return
	}
	a.logger.Info("import_cancelled",
		"project_id", snapshot.ProjectID,
		"source_id", snapshot.SourceID,
		"source_name", snapshot.Label,
		"stage", "queued",
		"duration_ms", time.Since(snapshot.CreatedAt).Milliseconds(),
	)
}

func (a *App) recordImportFailure(err error, diagnostic importDiagnostic) *models.AppError {
	appErr := models.AsAppError(err)
	details := copyErrorDetails(appErr.Details)
	stage := detailString(details, "stage")
	if stage == "" {
		stage = "unknown"
		details["stage"] = stage
	}
	if diagnostic.SourceType != "" {
		if _, exists := details["sourceType"]; !exists {
			details["sourceType"] = diagnostic.SourceType
		}
	}
	if detailString(details, "suggestion") == "" {
		details["suggestion"] = "Retry the import and use the error reference if the problem continues"
	}
	if a.logger != nil {
		if appErr.Code == models.CodeCancelled {
			a.logger.Info("import_cancelled",
				"project_id", diagnostic.ProjectID,
				"source_id", diagnostic.SourceID,
				"source_name", filepath.Base(diagnostic.Path),
				"source_type", diagnostic.SourceType,
				"source_size_bytes", diagnostic.Size,
				"stage", stage,
				"duration_ms", elapsedMilliseconds(diagnostic.StartedAt),
			)
			return models.WrapError(appErr.Code, appErr.Message, err, details)
		}
		reference := a.logger.Error("import_failed", err, []string{diagnostic.Path},
			"project_id", diagnostic.ProjectID,
			"source_id", diagnostic.SourceID,
			"source_name", filepath.Base(diagnostic.Path),
			"source_type", diagnostic.SourceType,
			"source_size_bytes", diagnostic.Size,
			"stage", stage,
			"duration_ms", elapsedMilliseconds(diagnostic.StartedAt),
		)
		if reference != "" {
			details["errorRef"] = reference
			details["logPath"] = a.logger.Path()
		} else {
			details["suggestion"] = "Retry the import; the diagnostic log could not be written"
		}
	}
	return models.WrapError(appErr.Code, appErr.Message, err, details)
}

func newImportDiagnostic(projectID, sourceID, path, sourceType string, startedAt time.Time) importDiagnostic {
	var size int64
	if info, err := os.Stat(path); err == nil {
		size = info.Size()
	}
	if startedAt.IsZero() {
		startedAt = time.Now()
	}
	return importDiagnostic{ProjectID: projectID, SourceID: sourceID, Path: path, SourceType: sourceType, Size: size, StartedAt: startedAt}
}

func copyErrorDetails(details map[string]any) map[string]any {
	result := make(map[string]any, len(details)+4)
	for key, value := range details {
		result[key] = value
	}
	return result
}

func detailString(details map[string]any, key string) string {
	value, _ := details[key].(string)
	return value
}

func elapsedMilliseconds(startedAt time.Time) int64 {
	if startedAt.IsZero() {
		return 0
	}
	return time.Since(startedAt).Milliseconds()
}
