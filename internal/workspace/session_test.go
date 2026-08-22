package workspace_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"ducs-table/internal/models"
)

func TestProjectSessionRoundTripHistoryBoundAndReconciliation(t *testing.T) {
	ctx, db, service, project := testWorkspace(t)
	dataset := insertSource(t, db, project.ID, "dataset-1", "data", "session_dataset", false)
	result := insertSource(t, db, project.ID, "result-1", "result", "session_result", true)
	if _, err := db.SQL().ExecContext(ctx, `INSERT INTO ducs_meta.connections (id, name, kind, catalog_name, config_json) VALUES ('conn-1', 'Warehouse', 'postgres', 'warehouse', '{}')`); err != nil {
		t.Fatal(err)
	}
	if err := service.AttachConnection(ctx, project.ID, "conn-1"); err != nil {
		t.Fatal(err)
	}
	active := "local:dataset-1"
	duration := int64(17)
	session := models.ProjectSession{
		Version:  models.ProjectSessionVersion,
		SQLDraft: "SELECT * FROM data.session_dataset",
		Tabs: []models.ProjectTabReference{
			{ID: active, Kind: models.ProjectTabKindLocal, Title: "Dataset", SourceID: dataset.ID},
			{ID: "external:orders", Kind: models.ProjectTabKindExternal, Title: "Orders", ConnectionID: "conn-1", RelationID: "orders-relation", Catalog: "warehouse", Schema: "public", Relation: "orders", RelationType: "table"},
		},
		ActiveTabID: &active,
		History: []models.QueryHistoryEntry{{
			ID: "history-1", SQL: "SELECT 1", RanAt: time.Date(2025, 2, 3, 4, 5, 6, 0, time.UTC), DurationMS: &duration, Status: "success",
		}},
		ResultSequence: 7,
	}
	if err := service.SaveSession(ctx, project.ID, session); err != nil {
		t.Fatalf("%v (cause: %v)", err, errors.Unwrap(err))
	}
	loaded, err := service.LoadSession(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(loaded, session) {
		t.Fatalf("session round trip\n got: %#v\nwant: %#v", loaded, session)
	}
	placeholder := session
	placeholder.Tabs = append([]models.ProjectTabReference(nil), session.Tabs...)
	placeholder.Tabs[1].Kind = models.ProjectTabKindPlaceholder
	placeholder.Tabs[1].PlaceholderReason = "disconnected"
	if err := service.SaveSession(ctx, project.ID, placeholder); err != nil {
		t.Fatal(err)
	}
	loaded, err = service.LoadSession(ctx, project.ID)
	if err != nil || !reflect.DeepEqual(loaded, placeholder) {
		t.Fatalf("placeholder round trip = %#v, err=%v", loaded, err)
	}

	many := session
	many.History = make([]models.QueryHistoryEntry, 25)
	for i := range many.History {
		many.History[i] = models.QueryHistoryEntry{
			ID: fmt.Sprintf("history-%02d", i), SQL: "SELECT 1",
			RanAt: time.Date(2025, 2, 3, 4, 5, i, 0, time.UTC), Status: "success",
		}
	}
	if err := service.SaveSession(ctx, project.ID, many); err != nil {
		t.Fatal(err)
	}
	loaded, err = service.LoadSession(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.History) != 20 || loaded.History[0].ID != "history-00" || loaded.History[19].ID != "history-19" {
		t.Fatalf("bounded history = %#v", loaded.History)
	}

	activeResult := "local:result-1"
	cleanupState := models.ProjectSession{
		Version: models.ProjectSessionVersion,
		Tabs: []models.ProjectTabReference{
			{ID: active, Kind: models.ProjectTabKindLocal, Title: "Dataset", SourceID: dataset.ID},
			{ID: activeResult, Kind: models.ProjectTabKindLocal, Title: "Result", SourceID: result.ID, IsResult: true},
		},
		ActiveTabID: &activeResult,
		History:     []models.QueryHistoryEntry{},
	}
	if err := service.SaveSession(ctx, project.ID, cleanupState); err != nil {
		t.Fatal(err)
	}
	if err := db.CleanupStartup(ctx); err != nil {
		t.Fatal(err)
	}
	loaded, err = service.LoadSession(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Tabs) != 1 || loaded.Tabs[0].SourceID != dataset.ID || loaded.ActiveTabID != nil {
		t.Fatalf("reconciled session = %#v", loaded)
	}
	var stateJSON string
	if err := db.SQL().QueryRowContext(ctx, `SELECT state_json FROM ducs_meta.project_sessions WHERE project_id = ?`, project.ID).Scan(&stateJSON); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stateJSON, result.ID) {
		t.Fatalf("stale result tab remained persisted: %s", stateJSON)
	}

	invalid := models.ProjectSession{Version: 2, Tabs: []models.ProjectTabReference{}, History: []models.QueryHistoryEntry{}}
	if err := service.SaveSession(ctx, project.ID, invalid); errorCode(err) != models.CodeInvalidArgument {
		t.Fatalf("invalid session error = %#v", err)
	}
	spare, err := service.CreateProject(context.Background(), "Spare", "")
	if err != nil {
		t.Fatal(err)
	}
	_ = spare
	if _, err := service.ArchiveProject(ctx, project.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.LoadSession(ctx, project.ID); errorCode(err) != models.CodeProjectArchived {
		t.Fatalf("archived session error = %#v", err)
	}
}
