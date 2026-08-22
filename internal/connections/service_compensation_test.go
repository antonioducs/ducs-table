package connections

import (
	"context"
	"errors"
	"testing"

	"ducs-table/internal/credentials"
	"ducs-table/internal/models"
)

type failingRepository struct {
	current              ConnectionInfo
	createErr, updateErr error
}

type staleCredentialStore struct {
	replacement credentials.Secret
	replaced    bool
}

func (s *staleCredentialStore) Set(_ context.Context, _ string, secret credentials.Secret) error {
	s.replacement = secret
	s.replaced = true
	return nil
}
func (s *staleCredentialStore) Get(context.Context, string) (credentials.Secret, error) {
	if !s.replaced {
		return credentials.Secret{}, models.NewError(models.CodeCredentialReauthRequired, "stale build", nil)
	}
	return s.replacement, nil
}
func (s *staleCredentialStore) Delete(context.Context, string) error      { return nil }
func (s *staleCredentialStore) Has(context.Context, string) (bool, error) { return true, nil }

func (f *failingRepository) List(context.Context) ([]ConnectionInfo, error) { return nil, nil }
func (f *failingRepository) Get(context.Context, string) (ConnectionInfo, error) {
	return f.current, nil
}
func (f *failingRepository) Create(context.Context, string, ConnectionInfo) error { return f.createErr }
func (f *failingRepository) Update(context.Context, ConnectionInfo) error         { return f.updateErr }
func (f *failingRepository) Delete(context.Context, string) error                 { return nil }

func TestCreateAndUpdateCredentialCompensation(t *testing.T) {
	ctx := context.Background()
	store := credentials.NewMemoryStore()
	repo := &failingRepository{createErr: errors.New("metadata failure")}
	service := &Service{repo: repo, credentials: store, runtime: make(map[string]runtimeState), relations: make(map[string]models.ExternalRelationInfo), connectionRelations: make(map[string]map[string]struct{})}
	request := CreateConnectionRequest{ProjectID: "project", Name: "Prod", Kind: KindPostgres, CatalogName: "prod", Config: validPostgresInfo().Config, Password: "new-secret"}
	if _, err := service.CreateConnection(ctx, request); err == nil {
		t.Fatal("create unexpectedly succeeded")
	}
	// The generated ID is intentionally opaque; a failed create must leave the
	// entire fake store empty.
	if keys := store.Len(); keys != 0 {
		t.Fatalf("credential rollback left %d item(s)", keys)
	}

	current := validPostgresInfo()
	current.ID = "existing"
	current.CatalogName = "prod"
	repo.current = current
	repo.createErr = nil
	repo.updateErr = errors.New("update failure")
	if err := store.Set(ctx, current.ID, credentials.Secret{Password: "old-secret"}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpdateConnection(ctx, UpdateConnectionRequest{ID: current.ID, Name: current.Name, CatalogName: current.CatalogName, Config: current.Config, Password: "replacement"}); err == nil {
		t.Fatal("update unexpectedly succeeded")
	}
	secret, err := store.Get(ctx, current.ID)
	if err != nil {
		t.Fatal(err)
	}
	if secret.Password != "old-secret" {
		t.Fatal("previous credential was not restored")
	}
}

func TestUpdateCanReplaceCredentialFromEarlierAdHocBuild(t *testing.T) {
	ctx := context.Background()
	current := validPostgresInfo()
	current.ID = "existing"
	current.CatalogName = "prod"
	repo := &failingRepository{current: current}
	store := &staleCredentialStore{}
	service := &Service{repo: repo, credentials: store, runtime: make(map[string]runtimeState), relations: make(map[string]models.ExternalRelationInfo), connectionRelations: make(map[string]map[string]struct{})}
	updated, err := service.UpdateConnection(ctx, UpdateConnectionRequest{ID: current.ID, Name: current.Name, CatalogName: current.CatalogName, Config: current.Config, Password: "replacement"})
	if err != nil {
		t.Fatal(err)
	}
	if !store.replaced || store.replacement.Password != "replacement" || updated.ID != current.ID {
		t.Fatal("stale credential was not replaced")
	}
}
