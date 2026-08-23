package ai

import (
	"context"
	"encoding/json"
	"testing"
)

type fakeRPC struct {
	method string
	params any
	closed bool
}

func (f *fakeRPC) Call(_ context.Context, method string, params, result any) error {
	f.method, f.params = method, params
	encoded, _ := json.Marshal(map[string]any{
		"provider": "codex", "available": true, "authenticated": true,
		"account": map[string]any{"email": "person@example.test", "accessToken": "must-not-cross-host-boundary"},
	})
	return json.Unmarshal(encoded, result)
}

func (f *fakeRPC) Close() error { f.closed = true; return nil }

func TestProviderLifecycleUsesRPCInterfaceAndSanitizesStatus(t *testing.T) {
	rpc := &fakeRPC{}
	service := NewService(context.Background(), nil, rpc, nil, nil, "", nil)
	status, err := service.ProviderStatus(context.Background(), ProviderCodex, true)
	if err != nil {
		t.Fatal(err)
	}
	if rpc.method != "provider.status" || !status.Available || !status.Authenticated {
		t.Fatalf("method=%q status=%#v", rpc.method, status)
	}
	account, ok := status.Account.(map[string]any)
	if !ok || account["email"] == nil || account["accessToken"] != nil {
		t.Fatalf("provider account was not sanitized: %#v", status.Account)
	}
	if err := service.Close(); err != nil {
		t.Fatal(err)
	}
	if !rpc.closed {
		t.Fatal("RPC fake was not closed")
	}
}
