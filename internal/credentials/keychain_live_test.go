package credentials

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestLiveMacOSKeychainRoundTrip(t *testing.T) {
	if os.Getenv("DUCS_TEST_KEYCHAIN") != "1" {
		t.Skip("set DUCS_TEST_KEYCHAIN=1 to test the real macOS Keychain")
	}
	ctx := context.Background()
	store := NewKeychainStore()
	key := fmt.Sprintf("test-%d", time.Now().UnixNano())
	defer func() { _ = store.Delete(context.Background(), key) }()
	if err := store.Set(ctx, key, Secret{Password: "round-trip-secret"}); err != nil {
		t.Fatal(err)
	}
	has, err := store.Has(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	if !has {
		t.Fatal("credential missing immediately after Set")
	}
	secret, err := store.Get(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	if secret.Password != "round-trip-secret" {
		t.Fatal("credential round-trip mismatch")
	}
}
