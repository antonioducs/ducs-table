package ai

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"ducs-table/internal/apppaths"
	"ducs-table/internal/connections"
	"ducs-table/internal/database"
	"ducs-table/internal/models"
)

type toolTestSources struct{ items []models.SourceInfo }

func (f toolTestSources) ListSources(context.Context, string) ([]models.SourceInfo, error) {
	return f.items, nil
}

type toolTestConnections struct{}

func (toolTestConnections) ListProjectConnections(context.Context, string) ([]connections.ConnectionInfo, error) {
	return nil, nil
}
func (toolTestConnections) ListSchemas(context.Context, string, string) ([]connections.SchemaInfo, error) {
	return nil, nil
}
func (toolTestConnections) ListRelations(context.Context, connections.ListRelationsRequest) ([]models.ExternalRelationInfo, error) {
	return nil, nil
}
func (toolTestConnections) GetExternalRelation(context.Context, string, string) (models.ExternalRelationInfo, error) {
	return models.ExternalRelationInfo{}, nil
}

type toolTestPreviewer struct{ calls []string }

func (f *toolTestPreviewer) Preview(_ context.Context, sqlText string) (PreviewResult, error) {
	f.calls = append(f.calls, sqlText)
	return PreviewResult{Columns: []string{"count"}, Rows: []map[string]any{{"count": 1}}, Bytes: 32}, nil
}

func TestPreviewConversationGrantStillValidatesEveryQuery(t *testing.T) {
	emitted := make(chan ApprovalRequest, 1)
	approvals := NewApprovalManager(func(request ApprovalRequest) { emitted <- request })
	previewer := &toolTestPreviewer{}
	tools := NewTools(
		toolTestSources{items: []models.SourceInfo{{ProjectID: "p1", Schema: "data", SQLName: "orders"}}},
		toolTestConnections{}, previewer, approvals,
	)
	call := ToolContext{ProjectID: "p1", ConversationID: "c1", RunID: "r1", ToolCallID: "t1"}

	first := make(chan error, 1)
	go func() {
		_, err := tools.Execute(context.Background(), call, "preview_query", json.RawMessage(`{"sql":"select count(*) from orders"}`))
		first <- err
	}()
	request := <-emitted
	if err := approvals.Respond(request.ID, ApprovalAllowConversation); err != nil {
		t.Fatal(err)
	}
	if err := <-first; err != nil {
		t.Fatal(err)
	}

	call.ToolCallID = "t2"
	if _, err := tools.Execute(context.Background(), call, "preview_query", json.RawMessage(`{"sql":"select * from another_project_table"}`)); err == nil {
		t.Fatal("conversation authorization bypassed project SQL validation")
	}
	if len(previewer.calls) != 1 {
		t.Fatalf("invalid query reached previewer: %#v", previewer.calls)
	}

	call.ToolCallID = "t3"
	if _, err := tools.Execute(context.Background(), call, "preview_query", json.RawMessage(`{"sql":"select * from orders"}`)); err != nil {
		t.Fatalf("valid query did not reuse conversation authorization: %v", err)
	}
	if len(previewer.calls) != 2 {
		t.Fatalf("expected two bounded preview calls, got %#v", previewer.calls)
	}
	select {
	case unexpected := <-emitted:
		t.Fatalf("conversation authorization emitted another approval: %#v", unexpected)
	default:
	}
}

func TestDuckDBPreviewReturnsUsefulSafeSQLDiagnostic(t *testing.T) {
	paths, err := apppaths.ResolveAt(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.Open(context.Background(), paths)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.SQL().ExecContext(context.Background(), `CREATE TABLE data.ai_preview_fixture(total INTEGER)`); err != nil {
		t.Fatal(err)
	}

	_, err = NewDuckDBPreviewer(db, nil).Preview(context.Background(), `SELECT missing_total FROM data.ai_preview_fixture`)
	var appErr *models.AppError
	if !errors.As(err, &appErr) || appErr.Code != models.CodeInvalidQuery {
		t.Fatalf("error = %#v", err)
	}
	if appErr.Message == "Query preview could not be executed" || !strings.Contains(appErr.Message, "missing_total") {
		t.Fatalf("diagnostic = %q", appErr.Message)
	}
	if strings.Contains(appErr.Message, "SELECT missing_total") {
		t.Fatalf("SQL excerpt was exposed: %q", appErr.Message)
	}
}
