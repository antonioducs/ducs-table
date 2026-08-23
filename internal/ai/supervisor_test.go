package ai

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestJSONLPeerServesReverseRequestWhileCallIsPending(t *testing.T) {
	hostInput, sidecarOutput := io.Pipe()
	sidecarInput, hostOutput := io.Pipe()
	peer := NewJSONLPeer(hostInput, hostOutput, func(_ context.Context, method string, params json.RawMessage) (any, error) {
		if method != "tool.call" {
			t.Fatalf("reverse method = %q", method)
		}
		return map[string]any{"output": "bounded"}, nil
	}, nil)
	defer peer.Close()

	go func() {
		reader := bufio.NewReader(sidecarInput)
		line, _ := reader.ReadBytes('\n')
		var request wireMessage
		_ = json.Unmarshal(line, &request)
		_, _ = sidecarOutput.Write([]byte(`{"id":"sidecar:1","method":"tool.call","params":{"name":"validate_sql"}}` + "\n"))
		_, _ = reader.ReadBytes('\n')
		response, _ := json.Marshal(wireMessage{ID: request.ID, Result: json.RawMessage(`{"ok":true}`)})
		_, _ = sidecarOutput.Write(append(response, '\n'))
	}()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var result struct {
		OK bool `json:"ok"`
	}
	if err := peer.Call(ctx, "ping", map[string]any{}, &result); err != nil {
		t.Fatal(err)
	}
	if !result.OK {
		t.Fatal("missing call result")
	}
}

func TestResolveNodeBinaryPrefersPackagedSibling(t *testing.T) {
	t.Setenv("DUCS_AI_NODE", "")
	root := t.TempDir()
	entry := filepath.Join(root, "dist", "index.js")
	if err := os.MkdirAll(filepath.Dir(entry), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry, []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}
	node := filepath.Join(root, "node")
	if err := os.WriteFile(node, []byte("node"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := resolveNodeBinary(entry); got != node {
		t.Fatalf("node path = %q, want %q", got, node)
	}
}
