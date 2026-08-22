package credentials

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"ducs-table/internal/models"

	"github.com/99designs/keyring"
)

func TestSecretPasswordIsExcludedFromJSON(t *testing.T) {
	const password = "json-secret-marker"
	payload := struct {
		Name   string `json:"name"`
		Secret Secret `json:"secret"`
	}{Name: "connection", Secret: Secret{Password: password}}

	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	if strings.Contains(text, password) || strings.Contains(strings.ToLower(text), "password") {
		t.Fatalf("password was exposed in JSON: %s", text)
	}
}

func TestMemoryStoreLifecycleAndZeroValue(t *testing.T) {
	var store MemoryStore
	ctx := context.Background()

	has, err := store.Has(ctx, "connection")
	if err != nil {
		t.Fatal(err)
	}
	if has {
		t.Fatal("empty store reported a credential")
	}

	if err := store.Set(ctx, "connection", Secret{Password: "first"}); err != nil {
		t.Fatal(err)
	}
	if err := store.Set(ctx, "connection", Secret{Password: "updated"}); err != nil {
		t.Fatal(err)
	}

	secret, err := store.Get(ctx, "connection")
	if err != nil {
		t.Fatal(err)
	}
	if secret.Password != "updated" {
		t.Fatalf("password = %q, want updated value", secret.Password)
	}

	has, err = store.Has(ctx, "connection")
	if err != nil || !has {
		t.Fatalf("Has after Set = %v, %v", has, err)
	}
	if err := store.Delete(ctx, "connection"); err != nil {
		t.Fatal(err)
	}
	has, err = store.Has(ctx, "connection")
	if err != nil || has {
		t.Fatalf("Has after Delete = %v, %v", has, err)
	}
	_, err = store.Get(ctx, "connection")
	assertAppErrorCode(t, err, models.CodeCredentialNotFound)
	assertAppErrorCode(t, store.Delete(ctx, "connection"), models.CodeCredentialNotFound)
	assertAppErrorCode(t, store.Set(ctx, " ", Secret{Password: "must-not-appear"}), models.CodeInvalidArgument)
}

func TestMemoryStoreConcurrentAccess(t *testing.T) {
	store := NewMemoryStore()
	ctx := context.Background()
	const workers = 64

	start := make(chan struct{})
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			key := fmt.Sprintf("connection-%d", i)
			password := fmt.Sprintf("password-%d", i)
			if err := store.Set(ctx, key, Secret{Password: password}); err != nil {
				errs <- err
				return
			}
			has, err := store.Has(ctx, key)
			if err != nil {
				errs <- err
				return
			}
			if !has {
				errs <- fmt.Errorf("%s was not present", key)
				return
			}
			secret, err := store.Get(ctx, key)
			if err != nil {
				errs <- err
				return
			}
			if secret.Password != password {
				errs <- fmt.Errorf("%s returned the wrong password", key)
				return
			}
			if err := store.Delete(ctx, key); err != nil {
				errs <- err
			}
		}(i)
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}

func TestUnavailableStoreFailsClosed(t *testing.T) {
	const (
		key      = "unavailable-key-marker"
		password = "unavailable-password-marker"
	)
	store := NewUnavailableStore()
	ctx := context.Background()

	assertUnavailableError(t, store.Set(ctx, key, Secret{Password: password}), key, password)
	secret, err := store.Get(ctx, key)
	if secret != (Secret{}) {
		t.Fatal("unavailable Get returned a secret")
	}
	assertUnavailableError(t, err, key, password)
	assertUnavailableError(t, store.Delete(ctx, key), key, password)
	has, err := store.Has(ctx, key)
	if has {
		t.Fatal("unavailable Has reported a credential")
	}
	assertUnavailableError(t, err, key, password)
}

func TestProductionStoreAllowsOnlyMacOSKeychain(t *testing.T) {
	wantOpenError := errors.New("keychain unavailable")
	var config keyring.Config
	store := openKeychainStore(func(got keyring.Config) (keyring.Keyring, error) {
		config = got
		return nil, wantOpenError
	})

	if _, ok := store.(*UnavailableStore); !ok {
		t.Fatalf("store type = %T, want *UnavailableStore", store)
	}
	if config.ServiceName != keychainServiceName {
		t.Fatalf("service name = %q", config.ServiceName)
	}
	if len(config.AllowedBackends) != 1 || config.AllowedBackends[0] != keyring.KeychainBackend {
		t.Fatalf("allowed backends = %v, want only %q", config.AllowedBackends, keyring.KeychainBackend)
	}
	if !config.KeychainTrustApplication || !config.KeychainAccessibleWhenUnlocked {
		t.Fatalf("keychain security options were not configured: %+v", config)
	}
}

func TestKeychainStoreAdapter(t *testing.T) {
	ring := newFakeKeyring()
	store := &KeychainStore{ring: ring}
	ctx := context.Background()

	if err := store.Set(ctx, "connection", Secret{Password: "keychain-secret"}); err != nil {
		t.Fatal(err)
	}
	if got := string(ring.items["connection"].Data); got != "keychain-secret" {
		t.Fatalf("stored password = %q", got)
	}
	getCallsAfterSet := ring.getCalls
	has, err := store.Has(ctx, "connection")
	if err != nil || !has {
		t.Fatalf("Has = %v, %v", has, err)
	}
	if ring.getCalls != getCallsAfterSet {
		t.Fatal("Has read secret data instead of metadata")
	}
	secret, err := store.Get(ctx, "connection")
	if err != nil {
		t.Fatal(err)
	}
	if secret.Password != "keychain-secret" {
		t.Fatalf("retrieved password = %q", secret.Password)
	}
	if err := store.Delete(ctx, "connection"); err != nil {
		t.Fatal(err)
	}
	has, err = store.Has(ctx, "connection")
	if err != nil || has {
		t.Fatalf("Has after Delete = %v, %v", has, err)
	}
}

func TestKeychainStoreReplacesCredentialFromStaleAppACL(t *testing.T) {
	ring := newFakeKeyring()
	ring.getNotFoundCount = 1
	store := &KeychainStore{ring: ring}
	if err := store.Set(context.Background(), "connection", Secret{Password: "replacement"}); err != nil {
		t.Fatal(err)
	}
	secret, err := store.Get(context.Background(), "connection")
	if err != nil {
		t.Fatal(err)
	}
	if secret.Password != "replacement" {
		t.Fatal("replacement credential was not readable")
	}
	if ring.removeCalls != 1 || ring.setCalls != 2 {
		t.Fatalf("recovery calls: remove=%d set=%d", ring.removeCalls, ring.setCalls)
	}
}

func TestKeychainStoreExplainsStaleUnreadableCredential(t *testing.T) {
	ring := newFakeKeyring()
	ring.items["connection"] = keyring.Item{Key: "connection", Data: []byte("secret")}
	ring.getErr = keyring.ErrKeyNotFound
	store := &KeychainStore{ring: ring}
	_, err := store.Get(context.Background(), "connection")
	assertAppErrorCode(t, err, models.CodeCredentialReauthRequired)
}

func TestKeychainErrorsAreStableAndSanitized(t *testing.T) {
	const password = "backend-password-marker"
	ring := newFakeKeyring()
	ring.setErr = errors.New("backend rejected " + password)
	store := &KeychainStore{ring: ring}
	ctx := context.Background()

	err := store.Set(ctx, "connection", Secret{Password: password})
	assertUnavailableError(t, err, "connection", password)
	var appErr *models.AppError
	if !errors.As(err, &appErr) {
		t.Fatal("error is not an AppError")
	}
	if appErr.Cause != nil {
		t.Fatal("backend error was retained in the public error chain")
	}

	ring.setErr = nil
	_, err = store.Get(ctx, "missing")
	assertAppErrorCode(t, err, models.CodeCredentialNotFound)
	if has, hasErr := store.Has(ctx, "missing"); hasErr != nil || has {
		t.Fatalf("Has missing = %v, %v", has, hasErr)
	}
}

func assertAppErrorCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected AppError %s", code)
	}
	var appErr *models.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("error type = %T, want *models.AppError", err)
	}
	if appErr.Code != code {
		t.Fatalf("error code = %q, want %q", appErr.Code, code)
	}
}

func assertUnavailableError(t *testing.T, err error, forbidden ...string) {
	t.Helper()
	assertAppErrorCode(t, err, models.CodeCredentialStoreUnavailable)
	encoded, jsonErr := json.Marshal(err)
	if jsonErr != nil {
		t.Fatal(jsonErr)
	}
	visible := err.Error() + string(encoded)
	for _, value := range forbidden {
		if value != "" && strings.Contains(visible, value) {
			t.Fatalf("error exposed sensitive value %q", value)
		}
	}
}

type fakeKeyring struct {
	items            map[string]keyring.Item
	setErr           error
	getErr           error
	removeErr        error
	metadataErr      error
	getCalls         int
	getNotFoundCount int
	setCalls         int
	removeCalls      int
}

func newFakeKeyring() *fakeKeyring {
	return &fakeKeyring{items: make(map[string]keyring.Item)}
}

func (r *fakeKeyring) Get(key string) (keyring.Item, error) {
	r.getCalls++
	if r.getNotFoundCount > 0 {
		r.getNotFoundCount--
		return keyring.Item{}, keyring.ErrKeyNotFound
	}
	if r.getErr != nil {
		return keyring.Item{}, r.getErr
	}
	item, ok := r.items[key]
	if !ok {
		return keyring.Item{}, keyring.ErrKeyNotFound
	}
	return item, nil
}

func (r *fakeKeyring) GetMetadata(key string) (keyring.Metadata, error) {
	if r.metadataErr != nil {
		return keyring.Metadata{}, r.metadataErr
	}
	item, ok := r.items[key]
	if !ok {
		return keyring.Metadata{}, keyring.ErrKeyNotFound
	}
	item.Data = nil
	return keyring.Metadata{Item: &item}, nil
}

func (r *fakeKeyring) Set(item keyring.Item) error {
	r.setCalls++
	if r.setErr != nil {
		return r.setErr
	}
	item.Data = append([]byte(nil), item.Data...)
	r.items[item.Key] = item
	return nil
}

func (r *fakeKeyring) Remove(key string) error {
	r.removeCalls++
	if r.removeErr != nil {
		return r.removeErr
	}
	if _, ok := r.items[key]; !ok {
		return keyring.ErrKeyNotFound
	}
	delete(r.items, key)
	return nil
}

func (r *fakeKeyring) Keys() ([]string, error) {
	keys := make([]string, 0, len(r.items))
	for key := range r.items {
		keys = append(keys, key)
	}
	return keys, nil
}
