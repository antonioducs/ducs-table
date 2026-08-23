package ai

import (
	"context"
	"errors"
	"sync"
)

var ErrApprovalDenied = errors.New("tool execution was not approved")

type approvalScope struct {
	projectID      string
	conversationID string
	tool           string
}

type pendingApproval struct {
	request  ApprovalRequest
	decision chan ApprovalDecision
}

type ApprovalManager struct {
	mu      sync.Mutex
	pending map[string]pendingApproval
	granted map[approvalScope]struct{}
	emit    func(ApprovalRequest)
}

func NewApprovalManager(emit func(ApprovalRequest)) *ApprovalManager {
	return &ApprovalManager{
		pending: make(map[string]pendingApproval),
		granted: make(map[approvalScope]struct{}),
		emit:    emit,
	}
}

func (m *ApprovalManager) Request(ctx context.Context, request ApprovalRequest) error {
	decision := make(chan ApprovalDecision, 1)
	scope := scopeForApproval(request)
	m.mu.Lock()
	if _, granted := m.granted[scope]; granted {
		m.mu.Unlock()
		return nil
	}
	if _, exists := m.pending[request.ID]; exists {
		m.mu.Unlock()
		return errors.New("approval request already exists")
	}
	m.pending[request.ID] = pendingApproval{request: request, decision: decision}
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		delete(m.pending, request.ID)
		m.mu.Unlock()
	}()
	if m.emit != nil {
		m.emit(request)
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case response := <-decision:
		if response == ApprovalDeny {
			return ErrApprovalDenied
		}
		return nil
	}
}

func (m *ApprovalManager) Respond(id string, response ApprovalDecision) error {
	if !response.Valid() {
		return errors.New("approval decision is invalid")
	}
	m.mu.Lock()
	pending, exists := m.pending[id]
	if exists && response == ApprovalAllowConversation {
		m.granted[scopeForApproval(pending.request)] = struct{}{}
	}
	m.mu.Unlock()
	if !exists {
		return errors.New("approval request was not found or has expired")
	}
	select {
	case pending.decision <- response:
		return nil
	default:
		return errors.New("approval request was already answered")
	}
}

func (m *ApprovalManager) ClearConversation(projectID, conversationID string) {
	m.mu.Lock()
	for scope := range m.granted {
		if scope.projectID == projectID && scope.conversationID == conversationID {
			delete(m.granted, scope)
		}
	}
	pending := make([]pendingApproval, 0)
	for _, item := range m.pending {
		if item.request.ProjectID == projectID && item.request.ConversationID == conversationID {
			pending = append(pending, item)
		}
	}
	m.mu.Unlock()
	for _, item := range pending {
		select {
		case item.decision <- ApprovalDeny:
		default:
		}
	}
}

func (m *ApprovalManager) CancelAll() {
	m.mu.Lock()
	pending := m.pending
	m.pending = make(map[string]pendingApproval)
	m.granted = make(map[approvalScope]struct{})
	m.mu.Unlock()
	for _, item := range pending {
		select {
		case item.decision <- ApprovalDeny:
		default:
		}
	}
}

func scopeForApproval(request ApprovalRequest) approvalScope {
	return approvalScope{projectID: request.ProjectID, conversationID: request.ConversationID, tool: request.Tool}
}
