package credentials

import (
	"context"
	"sync"
)

// MemoryStore is a process-local Store intended for dependency injection in
// tests. Its zero value is ready to use.
type MemoryStore struct {
	mu      sync.RWMutex
	secrets map[string]Secret
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{secrets: make(map[string]Secret)}
}

func (s *MemoryStore) Set(ctx context.Context, key string, secret Secret) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s == nil {
		return unavailableError()
	}
	if err := validateKey(key); err != nil {
		return err
	}
	s.mu.Lock()
	if s.secrets == nil {
		s.secrets = make(map[string]Secret)
	}
	s.secrets[key] = secret
	s.mu.Unlock()
	return nil
}

func (s *MemoryStore) Get(ctx context.Context, key string) (Secret, error) {
	if err := ctx.Err(); err != nil {
		return Secret{}, err
	}
	if s == nil {
		return Secret{}, unavailableError()
	}
	if err := validateKey(key); err != nil {
		return Secret{}, err
	}
	s.mu.RLock()
	secret, ok := s.secrets[key]
	s.mu.RUnlock()
	if !ok {
		return Secret{}, notFoundError()
	}
	return secret, nil
}

func (s *MemoryStore) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s == nil {
		return unavailableError()
	}
	if err := validateKey(key); err != nil {
		return err
	}
	s.mu.Lock()
	_, ok := s.secrets[key]
	if ok {
		delete(s.secrets, key)
	}
	s.mu.Unlock()
	if !ok {
		return notFoundError()
	}
	return nil
}

func (s *MemoryStore) Has(ctx context.Context, key string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if s == nil {
		return false, unavailableError()
	}
	if err := validateKey(key); err != nil {
		return false, err
	}
	s.mu.RLock()
	_, ok := s.secrets[key]
	s.mu.RUnlock()
	return ok, nil
}

var _ Store = (*MemoryStore)(nil)

// Len is useful for asserting compensating transactions in tests without
// exposing any stored secret values.
func (s *MemoryStore) Len() int {
	if s == nil {
		return 0
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.secrets)
}
