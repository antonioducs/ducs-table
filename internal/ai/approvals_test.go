package ai

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestApprovalManagerAllowsOnceAndAsksAgain(t *testing.T) {
	emitted := make(chan ApprovalRequest, 2)
	manager := NewApprovalManager(func(request ApprovalRequest) { emitted <- request })
	request := ApprovalRequest{ID: "a1", ProjectID: "p1", ConversationID: "c1", Tool: "preview_query"}

	result := requestApproval(manager, request)
	<-emitted
	if err := manager.Respond(request.ID, ApprovalAllowOnce); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}

	request.ID = "a2"
	result = requestApproval(manager, request)
	select {
	case second := <-emitted:
		if second.ID != "a2" {
			t.Fatalf("unexpected second approval: %#v", second)
		}
	case <-time.After(time.Second):
		t.Fatal("allow once unexpectedly suppressed the next approval")
	}
	if err := manager.Respond(request.ID, ApprovalDeny); err != nil {
		t.Fatal(err)
	}
	if err := <-result; !errors.Is(err, ErrApprovalDenied) {
		t.Fatalf("expected denial, got %v", err)
	}
}

func TestApprovalManagerScopesConversationGrantAndClearsIt(t *testing.T) {
	emitted := make(chan ApprovalRequest, 4)
	manager := NewApprovalManager(func(request ApprovalRequest) { emitted <- request })
	request := ApprovalRequest{ID: "a1", ProjectID: "p1", ConversationID: "c1", Tool: "preview_query"}

	result := requestApproval(manager, request)
	<-emitted
	if err := manager.Respond(request.ID, ApprovalAllowConversation); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}

	automatic := request
	automatic.ID = "a2"
	if err := manager.Request(context.Background(), automatic); err != nil {
		t.Fatalf("conversation grant was not reused: %v", err)
	}
	select {
	case unexpected := <-emitted:
		t.Fatalf("conversation grant emitted another approval: %#v", unexpected)
	default:
	}

	otherConversation := request
	otherConversation.ID, otherConversation.ConversationID = "a3", "c2"
	otherResult := requestApproval(manager, otherConversation)
	if emittedRequest := <-emitted; emittedRequest.ID != "a3" {
		t.Fatalf("grant leaked to another conversation: %#v", emittedRequest)
	}
	if err := manager.Respond(otherConversation.ID, ApprovalDeny); err != nil {
		t.Fatal(err)
	}
	<-otherResult

	manager.ClearConversation("p1", "c1")
	automatic.ID = "a4"
	clearedResult := requestApproval(manager, automatic)
	if emittedRequest := <-emitted; emittedRequest.ID != "a4" {
		t.Fatalf("cleared grant was unexpectedly reused: %#v", emittedRequest)
	}
	if err := manager.Respond(automatic.ID, ApprovalDeny); err != nil {
		t.Fatal(err)
	}
	<-clearedResult
}

func requestApproval(manager *ApprovalManager, request ApprovalRequest) <-chan error {
	result := make(chan error, 1)
	go func() { result <- manager.Request(context.Background(), request) }()
	return result
}
