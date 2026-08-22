// Package credentials stores passwords without persisting them in the local
// workspace or exposing them across the JSON application boundary.
package credentials

import (
	"context"
	"strings"

	"ducs-table/internal/models"
)

// Secret is the sensitive value held by a Store. Password is deliberately
// excluded from every encoding/json representation, including when Secret is
// nested in another value.
type Secret struct {
	Password string `json:"-"`
}

func (Secret) String() string   { return "[redacted credential]" }
func (Secret) GoString() string { return "credentials.Secret{[redacted]}" }

// Store is the credential storage boundary used by application services.
type Store interface {
	Set(ctx context.Context, connectionID string, secret Secret) error
	Get(ctx context.Context, connectionID string) (Secret, error)
	Delete(ctx context.Context, connectionID string) error
	Has(ctx context.Context, connectionID string) (bool, error)
}

func validateKey(key string) error {
	if strings.TrimSpace(key) == "" {
		return models.NewError(models.CodeInvalidArgument, "Credential key is required", nil)
	}
	return nil
}

func notFoundError() error {
	return models.NewError(models.CodeCredentialNotFound, "The connection credential was not found", nil)
}

func unavailableError() error {
	return models.NewError(
		models.CodeCredentialStoreUnavailable,
		"Secure credential storage is unavailable",
		nil,
	)
}

func reauthRequiredError() error {
	return models.NewError(
		models.CodeCredentialReauthRequired,
		"The saved password belongs to an earlier app build. Re-enter it and save again; if macOS still blocks access, remove the old Duc's Table item in Keychain Access",
		nil,
	)
}
