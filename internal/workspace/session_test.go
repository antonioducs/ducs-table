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
	"ducs-table/internal/workspace"
)

func groupNode(groupID string, size float64) models.ProjectLayoutNode {
	return models.ProjectLayoutNode{Kind: models.ProjectLayoutKindGroup, GroupID: groupID, Size: size}
}

func splitNode(direction string, children ...models.ProjectLayoutNode) models.ProjectLayoutNode {
	return models.ProjectLayoutNode{Kind: models.ProjectLayoutKindSplit, Direction: direction, Size: 100, Children: children}
}

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
	dataTab := "tab-dataset"
	externalTab := "tab-external"
	sqlTab := "tab-sql"
	duration := int64(17)
	session := models.ProjectSession{
		Version: models.ProjectSessionVersion,
		Documents: []models.SQLDocument{
			{ID: "doc-1", Title: "Query 1", SQL: "SELECT * FROM data.session_dataset", UpdatedAt: time.Date(2025, 2, 3, 4, 5, 6, 0, time.UTC)},
		},
		Tabs: []models.ProjectTabReference{
			{ID: dataTab, Kind: models.ProjectTabKindLocal, Title: "Dataset", SourceID: dataset.ID},
			{ID: externalTab, Kind: models.ProjectTabKindExternal, Title: "Orders", ConnectionID: "conn-1", RelationID: "orders-relation", Catalog: "warehouse", Schema: "public", Relation: "orders", RelationType: "table"},
			{ID: sqlTab, Kind: models.ProjectTabKindSQL, Title: "Query 1", DocumentID: "doc-1"},
		},
		Groups: []models.ProjectTabGroup{
			{ID: "group-data", TabIDs: []string{dataTab, externalTab}, ActiveTabID: &dataTab},
			{ID: "group-sql", TabIDs: []string{sqlTab}, ActiveTabID: &sqlTab},
		},
		Layout:        splitNode(models.ProjectLayoutVertical, groupNode("group-data", 71), groupNode("group-sql", 29)),
		ActiveGroupID: "group-data",
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

	resultTab := "tab-result"
	cleanupState := models.ProjectSession{
		Version:   models.ProjectSessionVersion,
		Documents: []models.SQLDocument{},
		Tabs: []models.ProjectTabReference{
			{ID: dataTab, Kind: models.ProjectTabKindLocal, Title: "Dataset", SourceID: dataset.ID},
			{ID: resultTab, Kind: models.ProjectTabKindLocal, Title: "Result", SourceID: result.ID, IsResult: true},
		},
		Groups: []models.ProjectTabGroup{
			{ID: "group-data", TabIDs: []string{dataTab}, ActiveTabID: &dataTab},
			{ID: "group-result", TabIDs: []string{resultTab}, ActiveTabID: &resultTab},
		},
		Layout:        splitNode(models.ProjectLayoutHorizontal, groupNode("group-data", 50), groupNode("group-result", 50)),
		ActiveGroupID: "group-result",
		History:       []models.QueryHistoryEntry{},
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
	if len(loaded.Tabs) != 1 || loaded.Tabs[0].SourceID != dataset.ID {
		t.Fatalf("reconciled session = %#v", loaded)
	}
	if len(loaded.Groups) != 1 || loaded.Groups[0].ID != "group-data" || loaded.ActiveGroupID != "group-data" {
		t.Fatalf("reconciled groups collapsed incorrectly = %#v", loaded.Groups)
	}
	if loaded.Layout.Kind != models.ProjectLayoutKindGroup || loaded.Layout.GroupID != "group-data" {
		t.Fatalf("reconciled layout = %#v", loaded.Layout)
	}
	var stateJSON string
	if err := db.SQL().QueryRowContext(ctx, `SELECT state_json FROM ducs_meta.project_sessions WHERE project_id = ?`, project.ID).Scan(&stateJSON); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stateJSON, result.ID) {
		t.Fatalf("stale result tab remained persisted: %s", stateJSON)
	}

	// NormalizeSession repairs recoverable damage, so rejection is reserved for
	// identities that cannot be inferred, such as an unknown tab kind.
	invalid := models.ProjectSession{
		Version:   models.ProjectSessionVersion,
		Documents: []models.SQLDocument{},
		Tabs:      []models.ProjectTabReference{{ID: "tab-bad", Kind: "unknown", Title: "Bad"}},
		Groups:    []models.ProjectTabGroup{{ID: "group-a", TabIDs: []string{"tab-bad"}}},
		Layout:    groupNode("group-a", 100),
		History:   []models.QueryHistoryEntry{},
	}
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

func TestProjectSessionMigratesLegacyDraftIntoSQLTab(t *testing.T) {
	ctx, db, service, project := testWorkspace(t)
	dataset := insertSource(t, db, project.ID, "dataset-1", "data", "legacy_dataset", false)
	legacy := fmt.Sprintf(`{"version":1,"sqlDraft":"SELECT 42","tabs":[{"id":"local:%s","kind":"local","title":"Legacy","sourceId":"%s"}],"activeTabId":"local:%s","history":[],"resultSequence":3}`, dataset.ID, dataset.ID, dataset.ID)
	if _, err := db.SQL().ExecContext(ctx, `
		INSERT INTO ducs_meta.project_sessions (project_id, state_json, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (project_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`, project.ID, legacy, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}

	loaded, err := service.LoadSession(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Version != models.ProjectSessionVersion {
		t.Fatalf("migrated version = %d", loaded.Version)
	}
	if len(loaded.Documents) != 1 || loaded.Documents[0].SQL != "SELECT 42" {
		t.Fatalf("migrated documents = %#v", loaded.Documents)
	}
	if loaded.ResultSequence != 3 {
		t.Fatalf("migrated result sequence = %d", loaded.ResultSequence)
	}
	if len(loaded.Groups) != 2 {
		t.Fatalf("migrated groups = %#v", loaded.Groups)
	}
	if loaded.Layout.Kind != models.ProjectLayoutKindSplit || loaded.Layout.Direction != models.ProjectLayoutVertical || len(loaded.Layout.Children) != 2 {
		t.Fatalf("migrated layout = %#v", loaded.Layout)
	}
	var sqlTabs, localTabs int
	for _, tab := range loaded.Tabs {
		switch tab.Kind {
		case models.ProjectTabKindSQL:
			sqlTabs++
			if tab.DocumentID != loaded.Documents[0].ID {
				t.Fatalf("sql tab document = %q", tab.DocumentID)
			}
		case models.ProjectTabKindLocal:
			localTabs++
		}
	}
	if sqlTabs != 1 || localTabs != 1 {
		t.Fatalf("migrated tabs = %#v", loaded.Tabs)
	}

	var stateJSON string
	if err := db.SQL().QueryRowContext(ctx, `SELECT state_json FROM ducs_meta.project_sessions WHERE project_id = ?`, project.ID).Scan(&stateJSON); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stateJSON, `"sqlDraft"`) {
		t.Fatalf("migration was not persisted: %s", stateJSON)
	}

	again, err := service.LoadSession(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(again, loaded) {
		t.Fatalf("migrated session is not stable\n got: %#v\nwant: %#v", again, loaded)
	}
}

// The frontend serializes its own session shape, so a realistic payload is
// decoded and validated here to keep both sides of the contract honest.
func TestProjectSessionAcceptsFrontendPayload(t *testing.T) {
	ctx, db, service, project := testWorkspace(t)
	dataset := insertSource(t, db, project.ID, "dataset-1", "data", "frontend_dataset", false)
	payload := fmt.Sprintf(`{
		"version": 2,
		"documents": [{"id":"doc-abc","title":"Query 1","sql":"SELECT 1","updatedAt":"2026-08-26T12:00:00.000Z"}],
		"tabs": [
			{"id":"tab-1","kind":"local","title":"Dataset","sourceId":"%s","isResult":false},
			{"id":"tab-2","kind":"sql","title":"Query 1","documentId":"doc-abc"}
		],
		"groups": [
			{"id":"group-1","tabIds":["tab-1"],"activeTabId":"tab-1"},
			{"id":"group-2","tabIds":["tab-2"],"activeTabId":"tab-2"}
		],
		"layout": {"kind":"split","direction":"vertical","size":100,"children":[
			{"kind":"group","groupId":"group-1","size":71},
			{"kind":"group","groupId":"group-2","size":29}
		]},
		"activeGroupId": "group-2",
		"history": [{"id":"h1","sql":"SELECT 1","ranAt":"2026-08-26T12:00:00.000Z","durationMs":12,"status":"success"}],
		"resultSequence": 1
	}`, dataset.ID)

	if _, err := db.SQL().ExecContext(ctx, `
		INSERT INTO ducs_meta.project_sessions (project_id, state_json, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (project_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`, project.ID, payload, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}

	loaded, err := service.LoadSession(ctx, project.ID)
	if err != nil {
		t.Fatalf("frontend payload rejected: %v", err)
	}
	if len(loaded.Documents) != 1 || loaded.Documents[0].SQL != "SELECT 1" {
		t.Fatalf("documents = %#v", loaded.Documents)
	}
	if len(loaded.Groups) != 2 || loaded.ActiveGroupID != "group-2" {
		t.Fatalf("groups = %#v active=%q", loaded.Groups, loaded.ActiveGroupID)
	}
	if len(loaded.Layout.Children) != 2 || loaded.Layout.Children[0].Size != 71 || loaded.Layout.Children[1].Size != 29 {
		t.Fatalf("layout sizes were not preserved = %#v", loaded.Layout)
	}

	// Saving the loaded session back must be accepted unchanged.
	if err := service.SaveSession(ctx, project.ID, loaded); err != nil {
		t.Fatal(err)
	}
	again, err := service.LoadSession(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(again, loaded) {
		t.Fatalf("frontend payload round trip\n got: %#v\nwant: %#v", again, loaded)
	}
}

func TestNormalizeSessionRepairsStructure(t *testing.T) {
	active := "tab-missing"
	session := models.ProjectSession{
		Documents: []models.SQLDocument{
			{ID: "doc-1", Title: "Query 1", SQL: "SELECT 1"},
			{ID: "doc-orphan", Title: "Orphan", SQL: "SELECT 2"},
		},
		Tabs: []models.ProjectTabReference{
			{ID: "tab-sql", Kind: models.ProjectTabKindSQL, Title: "Query 1", DocumentID: "doc-1"},
			{ID: "tab-ghost", Kind: models.ProjectTabKindSQL, Title: "Ghost", DocumentID: "doc-gone"},
			{ID: "tab-loose", Kind: models.ProjectTabKindLocal, Title: "Loose", SourceID: "source-1"},
		},
		Groups: []models.ProjectTabGroup{
			{ID: "group-a", TabIDs: []string{"tab-sql", "tab-nope"}, ActiveTabID: &active},
			{ID: "group-empty", TabIDs: []string{}},
		},
		Layout:        splitNode(models.ProjectLayoutHorizontal, groupNode("group-a", 0), groupNode("group-empty", 0), groupNode("group-gone", 0)),
		ActiveGroupID: "group-gone",
	}

	if !workspace.NormalizeSession(&session) {
		t.Fatal("normalize reported no change for a broken session")
	}
	if len(session.Documents) != 1 || session.Documents[0].ID != "doc-1" {
		t.Fatalf("orphan documents survived = %#v", session.Documents)
	}
	if len(session.Tabs) != 2 {
		t.Fatalf("tabs = %#v", session.Tabs)
	}
	if len(session.Groups) != 1 || session.Groups[0].ID != "group-a" {
		t.Fatalf("groups = %#v", session.Groups)
	}
	if len(session.Groups[0].TabIDs) != 2 {
		t.Fatalf("loose tab was not adopted = %#v", session.Groups[0])
	}
	if session.Groups[0].ActiveTabID == nil || *session.Groups[0].ActiveTabID != "tab-loose" {
		t.Fatalf("active tab = %#v", session.Groups[0].ActiveTabID)
	}
	if session.Layout.Kind != models.ProjectLayoutKindGroup || session.Layout.GroupID != "group-a" || session.Layout.Size != 100 {
		t.Fatalf("layout = %#v", session.Layout)
	}
	if session.ActiveGroupID != "group-a" {
		t.Fatalf("active group = %q", session.ActiveGroupID)
	}
	if workspace.NormalizeSession(&session) {
		t.Fatal("normalize is not idempotent")
	}
}

func TestNormalizeSessionRescalesSplitSizes(t *testing.T) {
	session := models.ProjectSession{
		Version:   models.ProjectSessionVersion,
		Documents: []models.SQLDocument{},
		Tabs: []models.ProjectTabReference{
			{ID: "tab-a", Kind: models.ProjectTabKindLocal, Title: "A", SourceID: "source-a"},
			{ID: "tab-b", Kind: models.ProjectTabKindLocal, Title: "B", SourceID: "source-b"},
		},
		Groups: []models.ProjectTabGroup{
			{ID: "group-a", TabIDs: []string{"tab-a"}},
			{ID: "group-b", TabIDs: []string{"tab-b"}},
		},
		Layout:        splitNode(models.ProjectLayoutHorizontal, groupNode("group-a", 30), groupNode("group-b", 30)),
		ActiveGroupID: "group-a",
		History:       []models.QueryHistoryEntry{},
	}
	workspace.NormalizeSession(&session)
	if session.Layout.Children[0].Size != 50 || session.Layout.Children[1].Size != 50 {
		t.Fatalf("rescaled sizes = %#v", session.Layout.Children)
	}
	if workspace.NormalizeSession(&session) {
		t.Fatal("size normalization is not idempotent")
	}
}
