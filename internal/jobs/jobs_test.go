package jobs

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestCancelIsIdempotentAndShutdownJoins(t *testing.T) {
	manager := NewManager(1, nil)
	started := make(chan struct{})
	snapshot, err := manager.Submit(Metadata{ProjectID: "project-a", Kind: "blocking"}, func(ctx context.Context, reporter Reporter) (any, error) {
		close(started)
		reporter.Update(.5, "waiting")
		<-ctx.Done()
		return nil, ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("job did not start")
	}
	first, err := manager.Cancel(snapshot.ID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.Cancel(snapshot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if first.State != StateCancelled || second.State != StateCancelled {
		t.Fatalf("cancel states: %s, %s", first.State, second.State)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := manager.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Submit(Metadata{ProjectID: "project-a", Kind: "late"}, func(context.Context, Reporter) (any, error) { return nil, nil }); err == nil {
		t.Fatal("submission after shutdown succeeded")
	}
}

func TestJobFailureSnapshot(t *testing.T) {
	manager := NewManager(1, nil)
	want := errors.New("boom")
	snapshot, err := manager.Submit(Metadata{ProjectID: "project-a", Kind: "fail"}, func(context.Context, Reporter) (any, error) { return nil, want })
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		current, err := manager.Get(snapshot.ID)
		if err != nil {
			t.Fatal(err)
		}
		if current.State == StateFailed {
			if current.Error == nil {
				t.Fatal("failed job has no stable error")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job remained in %s", current.State)
		}
		time.Sleep(time.Millisecond)
	}
	if err := manager.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestWaitReturnsResultAndIsRepeatable(t *testing.T) {
	manager := NewManager(1, nil)
	snapshot, err := manager.Submit(Metadata{ProjectID: "project-a", Kind: "query", Label: "Smoke query", SourceID: "source-id"}, func(context.Context, Reporter) (any, error) {
		return "ready", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		final, err := manager.Wait(context.Background(), snapshot.ID)
		if err != nil {
			t.Fatal(err)
		}
		if final.State != StateCompleted || final.Result != "ready" || final.ProjectID != "project-a" || final.Label != "Smoke query" || final.SourceID != "source-id" {
			t.Fatalf("unexpected final snapshot: %+v", final)
		}
	}
	if err := manager.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestMetadataAndActiveProjectAreCapturedAtSubmission(t *testing.T) {
	manager := NewManager(1, nil)
	started := make(chan struct{})
	release := make(chan struct{})
	snapshot, err := manager.Submit(Metadata{ProjectID: "project-b", Kind: "import", Label: "Orders", SourceID: "source-b"}, func(context.Context, Reporter) (any, error) {
		close(started)
		<-release
		return nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	<-started
	if !manager.HasActiveProject("project-b") || manager.HasActiveProject("project-a") {
		t.Fatal("active job was not attributed to its captured project")
	}
	if snapshot.ProjectID != "project-b" {
		t.Fatalf("project id = %q", snapshot.ProjectID)
	}
	close(release)
	if _, err := manager.Wait(context.Background(), snapshot.ID); err != nil {
		t.Fatal(err)
	}
	if manager.HasActiveProject("project-b") {
		t.Fatal("completed job remained active")
	}
	if err := manager.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}
