package credentials

import (
	"bytes"
	"context"
	"errors"

	"github.com/99designs/keyring"
)

const keychainServiceName = "com.wails.ducs-table"

// KeychainStore persists credentials in the user's macOS Keychain.
type KeychainStore struct {
	ring keyring.Keyring
}

type keyringOpener func(keyring.Config) (keyring.Keyring, error)

// New returns the production credential store. If macOS Keychain is not
// available, the returned store fails closed with a stable AppError.
func New() Store { return NewKeychainStore() }

func NewKeychainStore() Store {
	return openKeychainStore(keyring.Open)
}

func openKeychainStore(open keyringOpener) Store {
	ring, err := open(keyring.Config{
		ServiceName:                    keychainServiceName,
		AllowedBackends:                []keyring.BackendType{keyring.KeychainBackend},
		KeychainTrustApplication:       true,
		KeychainAccessibleWhenUnlocked: true,
	})
	if err != nil || ring == nil {
		return NewUnavailableStore()
	}
	return &KeychainStore{ring: ring}
}

func (s *KeychainStore) Set(ctx context.Context, key string, secret Secret) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s == nil || s.ring == nil {
		return unavailableError()
	}
	if err := validateKey(key); err != nil {
		return err
	}
	item := keyring.Item{
		Key:   key,
		Data:  []byte(secret.Password),
		Label: "Duc's Table credential",
	}
	if err := s.ring.Set(item); err != nil {
		return keychainError(err)
	}
	stored, err := s.ring.Get(key)
	if err == nil && bytes.Equal(stored.Data, item.Data) {
		return nil
	}
	// Ad-hoc development builds are identified by their changing code hash.
	// Replace an unreadable item after the user explicitly re-enters a password
	// so its ACL belongs to the current build.
	if removeErr := s.ring.Remove(key); removeErr != nil && !errors.Is(removeErr, keyring.ErrKeyNotFound) {
		return reauthRequiredError()
	}
	if setErr := s.ring.Set(item); setErr != nil {
		return reauthRequiredError()
	}
	stored, err = s.ring.Get(key)
	if err != nil || !bytes.Equal(stored.Data, item.Data) {
		return reauthRequiredError()
	}
	return nil
}

func (s *KeychainStore) Get(ctx context.Context, key string) (Secret, error) {
	if err := ctx.Err(); err != nil {
		return Secret{}, err
	}
	if s == nil || s.ring == nil {
		return Secret{}, unavailableError()
	}
	if err := validateKey(key); err != nil {
		return Secret{}, err
	}
	item, err := s.ring.Get(key)
	if err != nil {
		if errors.Is(err, keyring.ErrKeyNotFound) {
			if _, metadataErr := s.ring.GetMetadata(key); metadataErr == nil {
				return Secret{}, reauthRequiredError()
			}
		}
		return Secret{}, keychainError(err)
	}
	return Secret{Password: string(item.Data)}, nil
}

func (s *KeychainStore) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s == nil || s.ring == nil {
		return unavailableError()
	}
	if err := validateKey(key); err != nil {
		return err
	}
	if err := s.ring.Remove(key); err != nil {
		return keychainError(err)
	}
	return nil
}

func (s *KeychainStore) Has(ctx context.Context, key string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if s == nil || s.ring == nil {
		return false, unavailableError()
	}
	if err := validateKey(key); err != nil {
		return false, err
	}
	_, err := s.ring.GetMetadata(key)
	if errors.Is(err, keyring.ErrKeyNotFound) {
		return false, nil
	}
	if err != nil {
		return false, unavailableError()
	}
	return true, nil
}

func keychainError(err error) error {
	if errors.Is(err, keyring.ErrKeyNotFound) {
		return notFoundError()
	}
	return unavailableError()
}

var _ Store = (*KeychainStore)(nil)
