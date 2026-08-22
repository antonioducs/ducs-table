package credentials

import "context"

// UnavailableStore is a fail-closed Store used when macOS Keychain cannot be
// opened. It never retains a failed write or reports a credential as present.
type UnavailableStore struct{}

func NewUnavailableStore() *UnavailableStore { return &UnavailableStore{} }

func (*UnavailableStore) Set(context.Context, string, Secret) error { return unavailableError() }
func (*UnavailableStore) Get(context.Context, string) (Secret, error) {
	return Secret{}, unavailableError()
}
func (*UnavailableStore) Delete(context.Context, string) error      { return unavailableError() }
func (*UnavailableStore) Has(context.Context, string) (bool, error) { return false, unavailableError() }

var _ Store = (*UnavailableStore)(nil)
