package models

import (
	"context"
	"errors"
	"fmt"
)

const (
	CodeInvalidArgument                  = "INVALID_ARGUMENT"
	CodeNotFound                         = "NOT_FOUND"
	CodeConflict                         = "CONFLICT"
	CodeDatabase                         = "DATABASE_ERROR"
	CodeIO                               = "IO_ERROR"
	CodeCancelled                        = "CANCELLED"
	CodeUnsupportedFile                  = "UNSUPPORTED_FILE_TYPE"
	CodeXLSUnsupported                   = "XLS_UNSUPPORTED"
	CodeXLSXExtensionUnavailable         = "XLSX_EXTENSION_UNAVAILABLE"
	CodeInvalidQuery                     = "INVALID_QUERY"
	CodeReadOnlyQueryRequired            = "READ_ONLY_QUERY_REQUIRED"
	CodeSourceNotFound                   = "SOURCE_NOT_FOUND"
	CodeColumnNotFound                   = "COLUMN_NOT_FOUND"
	CodeJobNotFound                      = "JOB_NOT_FOUND"
	CodeShuttingDown                     = "SHUTTING_DOWN"
	CodeConnectionNotFound               = "CONNECTION_NOT_FOUND"
	CodeConnectionFailed                 = "CONNECTION_FAILED"
	CodeConnectionNotConnected           = "CONNECTION_NOT_CONNECTED"
	CodeConnectionAlreadyExists          = "CONNECTION_ALREADY_EXISTS"
	CodeCredentialStoreUnavailable       = "CREDENTIAL_STORE_UNAVAILABLE"
	CodeCredentialNotFound               = "CREDENTIAL_NOT_FOUND"
	CodeCredentialReauthRequired         = "CREDENTIAL_REAUTH_REQUIRED"
	CodeExtensionUnavailable             = "EXTENSION_UNAVAILABLE"
	CodeCatalogLoadFailed                = "CATALOG_LOAD_FAILED"
	CodeExternalRelationNotFound         = "EXTERNAL_RELATION_NOT_FOUND"
	CodeSnapshotFailed                   = "SNAPSHOT_FAILED"
	CodeExperimentalExtensionUnavailable = "EXPERIMENTAL_EXTENSION_UNAVAILABLE"
)

// AppError is safe to serialize across the Wails boundary. Cause is retained
// for errors.Is/errors.As and logs, but never serialized as potentially
// sensitive database or file content.
type AppError struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
	Cause   error          `json:"-"`
}

func (e *AppError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *AppError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func NewError(code, message string, details map[string]any) *AppError {
	return &AppError{Code: code, Message: message, Details: details}
}

func WrapError(code, message string, cause error, details map[string]any) *AppError {
	return &AppError{Code: code, Message: message, Details: details, Cause: cause}
}

// AsAppError preserves stable service errors and maps context cancellation.
func AsAppError(err error) *AppError {
	if err == nil {
		return nil
	}
	var appErr *AppError
	if errors.As(err, &appErr) {
		return appErr
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return WrapError(CodeCancelled, "The operation was cancelled", err, nil)
	}
	return WrapError(CodeDatabase, "The operation failed", err, nil)
}
