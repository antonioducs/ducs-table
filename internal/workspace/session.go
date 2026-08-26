package workspace

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strings"
	"time"

	"ducs-table/internal/models"
)

const (
	maxQueryHistoryEntries = 20
	maxSessionDocuments    = 60
	maxSessionTabs         = 120
	maxSessionGroups       = 8
	maxLayoutDepth         = 6

	defaultDataGroupSize = 71
	defaultSQLGroupSize  = 29
)

func newSessionID(prefix string) string {
	id, err := models.NewID()
	if err != nil {
		return fmt.Sprintf("%s-%d", prefix, time.Now().UTC().UnixNano())
	}
	return prefix + "-" + id
}

func emptySession() models.ProjectSession {
	group := models.ProjectTabGroup{ID: newSessionID("group"), TabIDs: make([]string, 0)}
	return models.ProjectSession{
		Version:       models.ProjectSessionVersion,
		Documents:     make([]models.SQLDocument, 0),
		Tabs:          make([]models.ProjectTabReference, 0),
		Groups:        []models.ProjectTabGroup{group},
		Layout:        models.ProjectLayoutNode{Kind: models.ProjectLayoutKindGroup, GroupID: group.ID, Size: 100},
		ActiveGroupID: group.ID,
		History:       make([]models.QueryHistoryEntry, 0),
	}
}

func (s *Service) LoadSession(ctx context.Context, projectID string) (models.ProjectSession, error) {
	var session models.ProjectSession
	err := s.db.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireProject(ctx, tx, projectID, false); err != nil {
			return err
		}
		var stateJSON string
		err := tx.QueryRowContext(ctx, `SELECT state_json FROM ducs_meta.project_sessions WHERE project_id = ?`, projectID).Scan(&stateJSON)
		if errors.Is(err, sql.ErrNoRows) {
			session = emptySession()
			encoded, encodeErr := encodeSession(session)
			if encodeErr != nil {
				return encodeErr
			}
			_, err = tx.ExecContext(ctx, `INSERT INTO ducs_meta.project_sessions (project_id, state_json, updated_at) VALUES (?, ?, ?)`, projectID, encoded, time.Now().UTC())
			return err
		}
		if err != nil {
			return err
		}
		decoded, migrated, decodeErr := decodeStoredSession(stateJSON)
		if decodeErr != nil {
			return models.WrapError(models.CodeDatabase, "Stored project session is invalid", decodeErr, map[string]any{"projectId": projectID})
		}
		session = decoded
		changed, err := reconcileSession(ctx, tx, projectID, &session)
		if err != nil {
			return err
		}
		if changed || migrated {
			encoded, err := encodeSession(session)
			if err != nil {
				return err
			}
			_, err = tx.ExecContext(ctx, `UPDATE ducs_meta.project_sessions SET state_json = ?, updated_at = ? WHERE project_id = ?`, encoded, time.Now().UTC(), projectID)
			return err
		}
		return nil
	})
	if err != nil {
		var appErr *models.AppError
		if errors.As(err, &appErr) {
			return models.ProjectSession{}, appErr
		}
		return models.ProjectSession{}, models.WrapError(models.CodeDatabase, "Could not load project session", err, map[string]any{"projectId": projectID})
	}
	return session, nil
}

func (s *Service) LoadProjectSession(ctx context.Context, projectID string) (models.ProjectSession, error) {
	return s.LoadSession(ctx, projectID)
}

func (s *Service) SaveSession(ctx context.Context, projectID string, session models.ProjectSession) error {
	if len(session.History) > maxQueryHistoryEntries {
		session.History = append([]models.QueryHistoryEntry(nil), session.History[:maxQueryHistoryEntries]...)
	}
	NormalizeSession(&session)
	if err := validateSession(session); err != nil {
		return err
	}
	err := s.db.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireProject(ctx, tx, projectID, false); err != nil {
			return err
		}
		if _, err := reconcileSession(ctx, tx, projectID, &session); err != nil {
			return err
		}
		encoded, err := encodeSession(session)
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		_, err = tx.ExecContext(ctx, `
			INSERT INTO ducs_meta.project_sessions (project_id, state_json, updated_at) VALUES (?, ?, ?)
			ON CONFLICT (project_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`, projectID, encoded, now)
		return err
	})
	if err != nil {
		var appErr *models.AppError
		if errors.As(err, &appErr) {
			return appErr
		}
		return models.WrapError(models.CodeDatabase, "Could not save project session", err, map[string]any{"projectId": projectID})
	}
	return nil
}

func (s *Service) SaveProjectSession(ctx context.Context, projectID string, session models.ProjectSession) error {
	return s.SaveSession(ctx, projectID, session)
}

// sessionV1 is the legacy on-disk shape: one SQL draft and one tab strip.
type sessionV1 struct {
	Version        int                          `json:"version"`
	SQLDraft       string                       `json:"sqlDraft"`
	Tabs           []models.ProjectTabReference `json:"tabs"`
	ActiveTabID    *string                      `json:"activeTabId,omitempty"`
	History        []models.QueryHistoryEntry   `json:"history"`
	ResultSequence int                          `json:"resultSequence"`
}

func decodeStrict(value string, target any) error {
	decoder := json.NewDecoder(bytes.NewBufferString(value))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func peekSessionVersion(value string) (int, error) {
	var envelope struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal([]byte(value), &envelope); err != nil {
		return 0, err
	}
	return envelope.Version, nil
}

// decodeStoredSession reads either shape and reports whether a migration ran so
// the caller can persist the upgraded document.
func decodeStoredSession(value string) (models.ProjectSession, bool, error) {
	version, err := peekSessionVersion(value)
	if err != nil {
		return models.ProjectSession{}, false, err
	}
	if version <= models.ProjectSessionVersionV1 {
		var legacy sessionV1
		if err := decodeStrict(value, &legacy); err != nil {
			return models.ProjectSession{}, false, err
		}
		session := migrateSessionV1(legacy)
		NormalizeSession(&session)
		if err := validateSession(session); err != nil {
			return models.ProjectSession{}, false, err
		}
		return session, true, nil
	}
	var session models.ProjectSession
	if err := decodeStrict(value, &session); err != nil {
		return models.ProjectSession{}, false, err
	}
	changed := NormalizeSession(&session)
	if err := validateSession(session); err != nil {
		return models.ProjectSession{}, false, err
	}
	return session, changed, nil
}

// migrateSessionV1 reproduces the old fixed layout: data tabs above, a single
// SQL tab holding the previous draft below.
func migrateSessionV1(legacy sessionV1) models.ProjectSession {
	document := models.SQLDocument{ID: newSessionID("doc"), Title: "Query 1", SQL: legacy.SQLDraft, UpdatedAt: time.Now().UTC()}
	sqlTab := models.ProjectTabReference{ID: newSessionID("tab"), Kind: models.ProjectTabKindSQL, Title: document.Title, DocumentID: document.ID}

	dataGroup := models.ProjectTabGroup{ID: newSessionID("group"), TabIDs: make([]string, 0, len(legacy.Tabs))}
	tabs := make([]models.ProjectTabReference, 0, len(legacy.Tabs)+1)
	for _, tab := range legacy.Tabs {
		if strings.TrimSpace(tab.ID) == "" {
			continue
		}
		tab.DocumentID = ""
		tabs = append(tabs, tab)
		dataGroup.TabIDs = append(dataGroup.TabIDs, tab.ID)
	}
	if legacy.ActiveTabID != nil {
		for _, id := range dataGroup.TabIDs {
			if id == *legacy.ActiveTabID {
				active := *legacy.ActiveTabID
				dataGroup.ActiveTabID = &active
				break
			}
		}
	}
	tabs = append(tabs, sqlTab)
	sqlGroup := models.ProjectTabGroup{ID: newSessionID("group"), TabIDs: []string{sqlTab.ID}, ActiveTabID: &sqlTab.ID}

	history := legacy.History
	if history == nil {
		history = make([]models.QueryHistoryEntry, 0)
	}
	if len(history) > maxQueryHistoryEntries {
		history = append([]models.QueryHistoryEntry(nil), history[:maxQueryHistoryEntries]...)
	}
	resultSequence := legacy.ResultSequence
	if resultSequence < 0 {
		resultSequence = 0
	}
	return models.ProjectSession{
		Version:   models.ProjectSessionVersion,
		Documents: []models.SQLDocument{document},
		Tabs:      tabs,
		Groups:    []models.ProjectTabGroup{dataGroup, sqlGroup},
		Layout: models.ProjectLayoutNode{
			Kind:      models.ProjectLayoutKindSplit,
			Direction: models.ProjectLayoutVertical,
			Size:      100,
			Children: []models.ProjectLayoutNode{
				{Kind: models.ProjectLayoutKindGroup, GroupID: dataGroup.ID, Size: defaultDataGroupSize},
				{Kind: models.ProjectLayoutKindGroup, GroupID: sqlGroup.ID, Size: defaultSQLGroupSize},
			},
		},
		ActiveGroupID:  dataGroup.ID,
		History:        history,
		ResultSequence: resultSequence,
	}
}

func encodeSession(session models.ProjectSession) (string, error) {
	encoded, err := json.Marshal(session)
	if err != nil {
		return "", fmt.Errorf("encode project session: %w", err)
	}
	return string(encoded), nil
}

// NormalizeSession repairs structural invariants in place and reports whether
// anything changed. It never fails: a hopeless layout falls back to the default
// so a corrupt UI state can never lock a project out.
func NormalizeSession(session *models.ProjectSession) bool {
	changed := false
	if session.Version != models.ProjectSessionVersion {
		session.Version = models.ProjectSessionVersion
		changed = true
	}
	if session.Documents == nil {
		session.Documents = make([]models.SQLDocument, 0)
		changed = true
	}
	if session.Tabs == nil {
		session.Tabs = make([]models.ProjectTabReference, 0)
		changed = true
	}
	if session.History == nil {
		session.History = make([]models.QueryHistoryEntry, 0)
		changed = true
	}
	if session.ResultSequence < 0 {
		session.ResultSequence = 0
		changed = true
	}
	if len(session.History) > maxQueryHistoryEntries {
		session.History = append([]models.QueryHistoryEntry(nil), session.History[:maxQueryHistoryEntries]...)
		changed = true
	}

	// Documents: unique IDs, bounded count.
	documents := make([]models.SQLDocument, 0, len(session.Documents))
	documentIDs := make(map[string]struct{}, len(session.Documents))
	for _, document := range session.Documents {
		if strings.TrimSpace(document.ID) == "" {
			changed = true
			continue
		}
		if _, exists := documentIDs[document.ID]; exists {
			changed = true
			continue
		}
		if strings.TrimSpace(document.Title) == "" {
			document.Title = "Query"
			changed = true
		}
		documentIDs[document.ID] = struct{}{}
		documents = append(documents, document)
	}
	if len(documents) > maxSessionDocuments {
		documents = documents[:maxSessionDocuments]
		documentIDs = make(map[string]struct{}, len(documents))
		for _, document := range documents {
			documentIDs[document.ID] = struct{}{}
		}
		changed = true
	}
	if len(documents) != len(session.Documents) {
		changed = true
	}

	// Tabs: unique IDs, valid identity, bounded count.
	tabs := make([]models.ProjectTabReference, 0, len(session.Tabs))
	tabIDs := make(map[string]struct{}, len(session.Tabs))
	usedDocuments := make(map[string]struct{}, len(documents))
	for _, tab := range session.Tabs {
		if strings.TrimSpace(tab.ID) == "" {
			changed = true
			continue
		}
		if _, exists := tabIDs[tab.ID]; exists {
			changed = true
			continue
		}
		if tab.Kind == models.ProjectTabKindSQL {
			if _, exists := documentIDs[tab.DocumentID]; !exists {
				changed = true
				continue
			}
			if _, exists := usedDocuments[tab.DocumentID]; exists {
				changed = true
				continue
			}
			usedDocuments[tab.DocumentID] = struct{}{}
		}
		if len(tabs) >= maxSessionTabs {
			changed = true
			continue
		}
		tabIDs[tab.ID] = struct{}{}
		tabs = append(tabs, tab)
	}
	if len(tabs) != len(session.Tabs) {
		changed = true
	}

	// Drop documents whose SQL tab is gone: drafts live and die with their tab.
	keptDocuments := make([]models.SQLDocument, 0, len(documents))
	for _, document := range documents {
		if _, used := usedDocuments[document.ID]; !used {
			changed = true
			continue
		}
		keptDocuments = append(keptDocuments, document)
	}
	session.Documents = keptDocuments
	session.Tabs = tabs

	// Groups: unique IDs, tabs assigned to exactly one group.
	groups := make([]models.ProjectTabGroup, 0, len(session.Groups))
	groupIDs := make(map[string]struct{}, len(session.Groups))
	assigned := make(map[string]struct{}, len(tabs))
	for _, group := range session.Groups {
		if strings.TrimSpace(group.ID) == "" {
			changed = true
			continue
		}
		if _, exists := groupIDs[group.ID]; exists {
			changed = true
			continue
		}
		if len(groups) >= maxSessionGroups {
			changed = true
			continue
		}
		ids := make([]string, 0, len(group.TabIDs))
		for _, tabID := range group.TabIDs {
			if _, exists := tabIDs[tabID]; !exists {
				changed = true
				continue
			}
			if _, already := assigned[tabID]; already {
				changed = true
				continue
			}
			assigned[tabID] = struct{}{}
			ids = append(ids, tabID)
		}
		if len(ids) != len(group.TabIDs) {
			changed = true
		}
		group.TabIDs = ids
		groupIDs[group.ID] = struct{}{}
		groups = append(groups, group)
	}
	if len(groups) == 0 {
		group := models.ProjectTabGroup{ID: newSessionID("group"), TabIDs: make([]string, 0)}
		groups = append(groups, group)
		groupIDs[group.ID] = struct{}{}
		changed = true
	}

	// Orphan tabs land in the first group so nothing becomes unreachable.
	for _, tab := range tabs {
		if _, ok := assigned[tab.ID]; ok {
			continue
		}
		groups[0].TabIDs = append(groups[0].TabIDs, tab.ID)
		assigned[tab.ID] = struct{}{}
		changed = true
	}

	// Collapse empty groups, keeping at least one.
	nonEmpty := make([]models.ProjectTabGroup, 0, len(groups))
	for _, group := range groups {
		if len(group.TabIDs) == 0 {
			continue
		}
		nonEmpty = append(nonEmpty, group)
	}
	if len(nonEmpty) == 0 {
		nonEmpty = append(nonEmpty, models.ProjectTabGroup{ID: groups[0].ID, TabIDs: make([]string, 0)})
	}
	if len(nonEmpty) != len(groups) {
		changed = true
	}
	groups = nonEmpty
	groupIDs = make(map[string]struct{}, len(groups))
	for i := range groups {
		groupIDs[groups[i].ID] = struct{}{}
		if groups[i].TabIDs == nil {
			groups[i].TabIDs = make([]string, 0)
			changed = true
		}
		active := groups[i].ActiveTabID
		valid := false
		if active != nil {
			for _, tabID := range groups[i].TabIDs {
				if tabID == *active {
					valid = true
					break
				}
			}
		}
		if !valid {
			if len(groups[i].TabIDs) == 0 {
				if groups[i].ActiveTabID != nil {
					groups[i].ActiveTabID = nil
					changed = true
				}
			} else {
				last := groups[i].TabIDs[len(groups[i].TabIDs)-1]
				groups[i].ActiveTabID = &last
				changed = true
			}
		}
	}
	session.Groups = groups

	if normalizeLayoutTree(session, groupIDs) {
		changed = true
	}

	if _, ok := groupIDs[session.ActiveGroupID]; !ok {
		session.ActiveGroupID = groups[0].ID
		changed = true
	}
	return changed
}

func normalizeLayoutTree(session *models.ProjectSession, groupIDs map[string]struct{}) bool {
	seen := make(map[string]struct{}, len(groupIDs))
	root, changed := normalizeLayoutNode(session.Layout, groupIDs, seen, 0)
	if root == nil {
		changed = true
		root = &models.ProjectLayoutNode{Kind: models.ProjectLayoutKindGroup, GroupID: session.Groups[0].ID, Size: 100}
		seen[session.Groups[0].ID] = struct{}{}
	}
	for _, group := range session.Groups {
		if _, ok := seen[group.ID]; ok {
			continue
		}
		changed = true
		leaf := models.ProjectLayoutNode{Kind: models.ProjectLayoutKindGroup, GroupID: group.ID}
		seen[group.ID] = struct{}{}
		if root.Kind == models.ProjectLayoutKindSplit {
			root.Children = append(root.Children, leaf)
			normalizeSizes(root.Children)
			continue
		}
		split := models.ProjectLayoutNode{
			Kind:      models.ProjectLayoutKindSplit,
			Direction: models.ProjectLayoutVertical,
			Children:  []models.ProjectLayoutNode{*root, leaf},
		}
		normalizeSizes(split.Children)
		root = &split
	}
	root.Size = 100
	if !layoutEqual(session.Layout, *root) {
		changed = true
	}
	session.Layout = *root
	return changed
}

func normalizeLayoutNode(node models.ProjectLayoutNode, groupIDs map[string]struct{}, seen map[string]struct{}, depth int) (*models.ProjectLayoutNode, bool) {
	if depth > maxLayoutDepth {
		return nil, true
	}
	if node.Kind == models.ProjectLayoutKindSplit {
		changed := false
		children := make([]models.ProjectLayoutNode, 0, len(node.Children))
		for _, child := range node.Children {
			normalized, childChanged := normalizeLayoutNode(child, groupIDs, seen, depth+1)
			if childChanged {
				changed = true
			}
			if normalized == nil {
				continue
			}
			children = append(children, *normalized)
		}
		if len(children) == 0 {
			return nil, true
		}
		if len(children) == 1 {
			only := children[0]
			only.Size = node.Size
			return &only, true
		}
		direction := node.Direction
		if direction != models.ProjectLayoutHorizontal && direction != models.ProjectLayoutVertical {
			direction = models.ProjectLayoutHorizontal
			changed = true
		}
		if normalizeSizes(children) {
			changed = true
		}
		return &models.ProjectLayoutNode{Kind: models.ProjectLayoutKindSplit, Direction: direction, Size: node.Size, Children: children}, changed
	}
	if _, ok := groupIDs[node.GroupID]; !ok {
		return nil, true
	}
	if _, duplicate := seen[node.GroupID]; duplicate {
		return nil, true
	}
	seen[node.GroupID] = struct{}{}
	leaf := models.ProjectLayoutNode{Kind: models.ProjectLayoutKindGroup, GroupID: node.GroupID, Size: node.Size}
	return &leaf, node.Kind != models.ProjectLayoutKindGroup || len(node.Children) > 0 || node.Direction != ""
}

func round2(value float64) float64 {
	return math.Round(value*100) / 100
}

// normalizeSizes rescales sibling sizes to sum to 100 and is idempotent so
// repeated saves do not churn the persisted layout.
func normalizeSizes(children []models.ProjectLayoutNode) bool {
	count := len(children)
	if count == 0 {
		return false
	}
	changed := false
	total := 0.0
	positive := true
	for _, child := range children {
		if child.Size <= 0 || math.IsNaN(child.Size) || math.IsInf(child.Size, 0) {
			positive = false
		}
		total += child.Size
	}
	if !positive || total <= 0 {
		each := round2(100 / float64(count))
		accumulated := 0.0
		for i := 0; i < count-1; i++ {
			if children[i].Size != each {
				changed = true
			}
			children[i].Size = each
			accumulated += each
		}
		last := round2(100 - accumulated)
		if children[count-1].Size != last {
			changed = true
		}
		children[count-1].Size = last
		return changed
	}
	accumulated := 0.0
	for i := 0; i < count-1; i++ {
		scaled := round2(children[i].Size / total * 100)
		if children[i].Size != scaled {
			changed = true
		}
		children[i].Size = scaled
		accumulated += scaled
	}
	last := round2(100 - accumulated)
	if children[count-1].Size != last {
		changed = true
	}
	children[count-1].Size = last
	return changed
}

func layoutEqual(left, right models.ProjectLayoutNode) bool {
	if left.Kind != right.Kind || left.Direction != right.Direction || left.GroupID != right.GroupID || left.Size != right.Size {
		return false
	}
	if len(left.Children) != len(right.Children) {
		return false
	}
	for i := range left.Children {
		if !layoutEqual(left.Children[i], right.Children[i]) {
			return false
		}
	}
	return true
}

func validateSession(session models.ProjectSession) error {
	if session.Version != models.ProjectSessionVersion {
		return models.NewError(models.CodeInvalidArgument, "Project session version is unsupported", map[string]any{"version": session.Version})
	}
	if session.ResultSequence < 0 {
		return models.NewError(models.CodeInvalidArgument, "Result sequence cannot be negative", nil)
	}
	if len(session.History) > maxQueryHistoryEntries {
		return models.NewError(models.CodeInvalidArgument, "Project session history is too long", map[string]any{"maxEntries": maxQueryHistoryEntries})
	}
	if len(session.Documents) > maxSessionDocuments {
		return models.NewError(models.CodeInvalidArgument, "Project session has too many SQL documents", map[string]any{"maxDocuments": maxSessionDocuments})
	}
	if len(session.Tabs) > maxSessionTabs {
		return models.NewError(models.CodeInvalidArgument, "Project session has too many tabs", map[string]any{"maxTabs": maxSessionTabs})
	}
	if len(session.Groups) == 0 {
		return models.NewError(models.CodeInvalidArgument, "Project session needs at least one editor group", nil)
	}
	if len(session.Groups) > maxSessionGroups {
		return models.NewError(models.CodeInvalidArgument, "Project session has too many editor groups", map[string]any{"maxGroups": maxSessionGroups})
	}

	documentIDs := make(map[string]struct{}, len(session.Documents))
	for _, document := range session.Documents {
		if strings.TrimSpace(document.ID) == "" {
			return models.NewError(models.CodeInvalidArgument, "SQL document ID is required", nil)
		}
		if _, exists := documentIDs[document.ID]; exists {
			return models.NewError(models.CodeInvalidArgument, "SQL document IDs must be unique", map[string]any{"documentId": document.ID})
		}
		documentIDs[document.ID] = struct{}{}
	}

	tabIDs := make(map[string]struct{}, len(session.Tabs))
	for _, tab := range session.Tabs {
		if strings.TrimSpace(tab.ID) == "" {
			return models.NewError(models.CodeInvalidArgument, "Project tab ID is required", nil)
		}
		if _, exists := tabIDs[tab.ID]; exists {
			return models.NewError(models.CodeInvalidArgument, "Project tab IDs must be unique", map[string]any{"tabId": tab.ID})
		}
		tabIDs[tab.ID] = struct{}{}
		switch tab.Kind {
		case models.ProjectTabKindLocal:
			if strings.TrimSpace(tab.SourceID) == "" || tab.ConnectionID != "" || tab.RelationID != "" || tab.DocumentID != "" || tab.Catalog != "" || tab.Schema != "" || tab.Relation != "" || tab.RelationType != "" || tab.PlaceholderReason != "" {
				return models.NewError(models.CodeInvalidArgument, "Local project tab identity is invalid", map[string]any{"tabId": tab.ID})
			}
		case models.ProjectTabKindExternal:
			hasCoordinates := tab.Catalog != "" && tab.Schema != "" && tab.Relation != ""
			if tab.SourceID != "" || tab.DocumentID != "" || strings.TrimSpace(tab.ConnectionID) == "" || !hasCoordinates || strings.TrimSpace(tab.RelationType) == "" || tab.PlaceholderReason != "" {
				return models.NewError(models.CodeInvalidArgument, "External project tab identity is invalid", map[string]any{"tabId": tab.ID})
			}
		case models.ProjectTabKindPlaceholder:
			hasExternalIdentity := tab.SourceID == "" && tab.DocumentID == "" && strings.TrimSpace(tab.ConnectionID) != "" && tab.Catalog != "" && tab.Schema != "" && tab.Relation != "" && strings.TrimSpace(tab.RelationType) != ""
			if !hasExternalIdentity || tab.PlaceholderReason != "disconnected" {
				return models.NewError(models.CodeInvalidArgument, "Placeholder project tab identity is invalid", map[string]any{"tabId": tab.ID})
			}
		case models.ProjectTabKindSQL:
			if strings.TrimSpace(tab.DocumentID) == "" || tab.SourceID != "" || tab.ConnectionID != "" || tab.RelationID != "" || tab.Catalog != "" || tab.Schema != "" || tab.Relation != "" || tab.RelationType != "" || tab.PlaceholderReason != "" || tab.IsResult {
				return models.NewError(models.CodeInvalidArgument, "SQL project tab identity is invalid", map[string]any{"tabId": tab.ID})
			}
			if _, exists := documentIDs[tab.DocumentID]; !exists {
				return models.NewError(models.CodeInvalidArgument, "SQL project tab references a missing document", map[string]any{"tabId": tab.ID, "documentId": tab.DocumentID})
			}
		default:
			return models.NewError(models.CodeInvalidArgument, "Project tab kind is invalid", map[string]any{"tabId": tab.ID, "kind": tab.Kind})
		}
	}

	groupIDs := make(map[string]struct{}, len(session.Groups))
	assigned := make(map[string]struct{}, len(session.Tabs))
	for _, group := range session.Groups {
		if strings.TrimSpace(group.ID) == "" {
			return models.NewError(models.CodeInvalidArgument, "Editor group ID is required", nil)
		}
		if _, exists := groupIDs[group.ID]; exists {
			return models.NewError(models.CodeInvalidArgument, "Editor group IDs must be unique", map[string]any{"groupId": group.ID})
		}
		groupIDs[group.ID] = struct{}{}
		for _, tabID := range group.TabIDs {
			if _, exists := tabIDs[tabID]; !exists {
				return models.NewError(models.CodeInvalidArgument, "Editor group references a missing tab", map[string]any{"groupId": group.ID, "tabId": tabID})
			}
			if _, duplicate := assigned[tabID]; duplicate {
				return models.NewError(models.CodeInvalidArgument, "A project tab cannot belong to two editor groups", map[string]any{"tabId": tabID})
			}
			assigned[tabID] = struct{}{}
		}
		if group.ActiveTabID != nil {
			found := false
			for _, tabID := range group.TabIDs {
				if tabID == *group.ActiveTabID {
					found = true
					break
				}
			}
			if !found {
				return models.NewError(models.CodeInvalidArgument, "Active tab does not belong to its editor group", map[string]any{"groupId": group.ID, "tabId": *group.ActiveTabID})
			}
		}
	}
	if len(assigned) != len(session.Tabs) {
		return models.NewError(models.CodeInvalidArgument, "Every project tab must belong to an editor group", nil)
	}
	if _, ok := groupIDs[session.ActiveGroupID]; !ok {
		return models.NewError(models.CodeInvalidArgument, "Active editor group does not exist", map[string]any{"groupId": session.ActiveGroupID})
	}
	if err := validateLayout(session.Layout, groupIDs, make(map[string]struct{}, len(groupIDs)), 0); err != nil {
		return err
	}
	if len(groupIDs) != len(session.Groups) {
		return models.NewError(models.CodeInvalidArgument, "Editor groups are inconsistent", nil)
	}

	for _, entry := range session.History {
		if strings.TrimSpace(entry.ID) == "" || strings.TrimSpace(entry.SQL) == "" || entry.RanAt.IsZero() {
			return models.NewError(models.CodeInvalidArgument, "Query history entry is incomplete", nil)
		}
		if entry.Status != "success" && entry.Status != "error" {
			return models.NewError(models.CodeInvalidArgument, "Query history status is invalid", map[string]any{"status": entry.Status})
		}
		if entry.DurationMS != nil && *entry.DurationMS < 0 {
			return models.NewError(models.CodeInvalidArgument, "Query duration cannot be negative", nil)
		}
	}
	return nil
}

func validateLayout(node models.ProjectLayoutNode, groupIDs, seen map[string]struct{}, depth int) error {
	if depth > maxLayoutDepth {
		return models.NewError(models.CodeInvalidArgument, "Editor layout is nested too deeply", map[string]any{"maxDepth": maxLayoutDepth})
	}
	switch node.Kind {
	case models.ProjectLayoutKindGroup:
		if _, ok := groupIDs[node.GroupID]; !ok {
			return models.NewError(models.CodeInvalidArgument, "Editor layout references a missing group", map[string]any{"groupId": node.GroupID})
		}
		if _, duplicate := seen[node.GroupID]; duplicate {
			return models.NewError(models.CodeInvalidArgument, "Editor layout references a group twice", map[string]any{"groupId": node.GroupID})
		}
		seen[node.GroupID] = struct{}{}
		if len(node.Children) > 0 {
			return models.NewError(models.CodeInvalidArgument, "Editor layout leaves cannot have children", map[string]any{"groupId": node.GroupID})
		}
	case models.ProjectLayoutKindSplit:
		if node.Direction != models.ProjectLayoutHorizontal && node.Direction != models.ProjectLayoutVertical {
			return models.NewError(models.CodeInvalidArgument, "Editor layout split direction is invalid", map[string]any{"direction": node.Direction})
		}
		if len(node.Children) < 2 {
			return models.NewError(models.CodeInvalidArgument, "Editor layout splits need at least two children", nil)
		}
		for _, child := range node.Children {
			if err := validateLayout(child, groupIDs, seen, depth+1); err != nil {
				return err
			}
		}
	default:
		return models.NewError(models.CodeInvalidArgument, "Editor layout node kind is invalid", map[string]any{"kind": node.Kind})
	}
	if depth == 0 && len(seen) != len(groupIDs) {
		return models.NewError(models.CodeInvalidArgument, "Editor layout must place every group", nil)
	}
	return nil
}

// reconcileSession drops tabs whose source metadata no longer belongs to this
// project, then repairs groups and layout. This removes stale result tabs after
// startup result cleanup and also heals sessions after a dataset is removed.
func reconcileSession(ctx context.Context, tx *sql.Tx, projectID string, session *models.ProjectSession) (bool, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id FROM ducs_meta.datasets WHERE project_id = ?`, projectID)
	if err != nil {
		return false, err
	}
	existing := make(map[string]struct{})
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return false, err
		}
		existing[id] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return false, err
	}
	if err := rows.Close(); err != nil {
		return false, err
	}
	connectionRows, err := tx.QueryContext(ctx, `SELECT connection_id FROM ducs_meta.project_connections WHERE project_id = ?`, projectID)
	if err != nil {
		return false, err
	}
	linkedConnections := make(map[string]struct{})
	for connectionRows.Next() {
		var id string
		if err := connectionRows.Scan(&id); err != nil {
			_ = connectionRows.Close()
			return false, err
		}
		linkedConnections[id] = struct{}{}
	}
	if err := connectionRows.Err(); err != nil {
		_ = connectionRows.Close()
		return false, err
	}
	if err := connectionRows.Close(); err != nil {
		return false, err
	}

	changed := false
	kept := make([]models.ProjectTabReference, 0, len(session.Tabs))
	for _, tab := range session.Tabs {
		if tab.Kind == models.ProjectTabKindLocal {
			if _, ok := existing[tab.SourceID]; !ok {
				changed = true
				continue
			}
		}
		if tab.Kind == models.ProjectTabKindExternal || tab.Kind == models.ProjectTabKindPlaceholder {
			if _, ok := linkedConnections[tab.ConnectionID]; !ok {
				changed = true
				continue
			}
		}
		kept = append(kept, tab)
	}
	if changed {
		session.Tabs = kept
	}
	if NormalizeSession(session) {
		changed = true
	}
	return changed, nil
}
