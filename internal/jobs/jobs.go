// Package jobs runs bounded background work with cancellation and snapshots.
package jobs

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"ducs-table/internal/models"
)

type State string

const (
	StateQueued    State = "queued"
	StateRunning   State = "running"
	StateCompleted State = "completed"
	StateFailed    State = "failed"
	StateCancelled State = "cancelled"
)

type Snapshot struct {
	ID         string           `json:"id"`
	ProjectID  string           `json:"projectId"`
	Kind       string           `json:"kind"`
	Label      string           `json:"label,omitempty"`
	SourceID   string           `json:"sourceId,omitempty"`
	State      State            `json:"state"`
	Progress   float64          `json:"progress"`
	Stage      string           `json:"stage,omitempty"`
	Message    string           `json:"message,omitempty"`
	Result     any              `json:"result,omitempty"`
	Error      *models.AppError `json:"error,omitempty"`
	CreatedAt  time.Time        `json:"createdAt"`
	StartedAt  *time.Time       `json:"startedAt,omitempty"`
	FinishedAt *time.Time       `json:"finishedAt,omitempty"`
}

// Metadata captures the immutable context of a job at submission time. In
// particular, ProjectID must never be inferred from whichever project happens
// to be open when asynchronous work completes.
type Metadata struct {
	ProjectID string `json:"projectId"`
	Kind      string `json:"kind"`
	Label     string `json:"label,omitempty"`
	SourceID  string `json:"sourceId,omitempty"`
}

type Reporter interface {
	Update(progress float64, message string)
}

type Task func(context.Context, Reporter) (any, error)
type Callback func(Snapshot)

type job struct {
	snapshot Snapshot
	ctx      context.Context
	cancel   context.CancelFunc
	done     chan struct{}
	doneOnce sync.Once
}

// Manager bounds concurrently running jobs. One lightweight goroutine waits on
// the semaphore per queued job; Shutdown cancels and joins every one of them.
type Manager struct {
	ctx      context.Context
	cancel   context.CancelFunc
	callback Callback
	sem      chan struct{}

	mu       sync.RWMutex
	jobs     map[string]*job
	closed   bool
	wg       sync.WaitGroup
	waitOnce sync.Once
	done     chan struct{}
}

func NewManager(concurrency int, callback Callback) *Manager {
	return NewManagerWithContext(context.Background(), concurrency, callback)
}

// NewManagerWithContext ties all jobs to a parent application context.
func NewManagerWithContext(parent context.Context, concurrency int, callback Callback) *Manager {
	if concurrency <= 0 {
		concurrency = 2
	}
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancel(parent)
	return &Manager{
		ctx: ctx, cancel: cancel, callback: callback,
		sem: make(chan struct{}, concurrency), jobs: make(map[string]*job), done: make(chan struct{}),
	}
}

func New(concurrency int, callback Callback) *Manager { return NewManager(concurrency, callback) }

// Submit associates immutable project and display metadata with a task.
func (m *Manager) Submit(metadata Metadata, task Task) (Snapshot, error) {
	if task == nil {
		return Snapshot{}, models.NewError(models.CodeInvalidArgument, "Job task is required", nil)
	}
	if metadata.ProjectID == "" {
		return Snapshot{}, models.NewError(models.CodeInvalidArgument, "Project ID is required", nil)
	}
	if metadata.Kind == "" {
		return Snapshot{}, models.NewError(models.CodeInvalidArgument, "Job kind is required", nil)
	}
	id, err := models.NewID()
	if err != nil {
		return Snapshot{}, fmt.Errorf("jobs: %w", err)
	}
	ctx, cancel := context.WithCancel(m.ctx)
	j := &job{snapshot: Snapshot{
		ID: id, ProjectID: metadata.ProjectID, Kind: metadata.Kind, Label: metadata.Label, SourceID: metadata.SourceID,
		State: StateQueued, CreatedAt: time.Now().UTC(),
	}, ctx: ctx, cancel: cancel, done: make(chan struct{})}

	m.mu.Lock()
	if m.closed || m.ctx.Err() != nil {
		m.mu.Unlock()
		cancel()
		return Snapshot{}, models.NewError(models.CodeShuttingDown, "Job manager is shutting down", nil)
	}
	m.jobs[id] = j
	m.wg.Add(1)
	snapshot := j.snapshot
	m.mu.Unlock()
	m.emit(snapshot)
	go m.run(j, task)
	return snapshot, nil
}

// HasActiveProject reports whether a project currently owns queued or running
// work. It is used to prevent archiving a context out from under its jobs.
func (m *Manager) HasActiveProject(projectID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, j := range m.jobs {
		if j.snapshot.ProjectID == projectID && !terminal(j.snapshot.State) {
			return true
		}
	}
	return false
}

func (m *Manager) run(j *job, task Task) {
	defer m.wg.Done()
	select {
	case m.sem <- struct{}{}:
		defer func() { <-m.sem }()
	case <-j.ctx.Done():
		m.finishCancelled(j)
		return
	}

	m.mu.Lock()
	if j.snapshot.State == StateCancelled || j.ctx.Err() != nil {
		m.mu.Unlock()
		m.finishCancelled(j)
		return
	}
	now := time.Now().UTC()
	j.snapshot.State = StateRunning
	j.snapshot.StartedAt = &now
	snapshot := j.snapshot
	m.mu.Unlock()
	m.emit(snapshot)

	result, err := task(j.ctx, reporter{manager: m, id: j.snapshot.ID})
	m.mu.Lock()
	finished := time.Now().UTC()
	j.snapshot.FinishedAt = &finished
	if err == nil {
		j.snapshot.State = StateCompleted
		j.snapshot.Progress = 1
		j.snapshot.Result = result
	} else if errors.Is(err, context.Canceled) || j.ctx.Err() != nil {
		j.snapshot.State = StateCancelled
		j.snapshot.Error = models.NewError(models.CodeCancelled, "Job was cancelled", nil)
	} else if err != nil {
		j.snapshot.State = StateFailed
		j.snapshot.Error = models.AsAppError(err)
	}
	snapshot = j.snapshot
	m.mu.Unlock()
	m.emit(snapshot)
	j.finish()
}

func (m *Manager) finishCancelled(j *job) {
	m.mu.Lock()
	if terminal(j.snapshot.State) {
		m.mu.Unlock()
		return
	}
	now := time.Now().UTC()
	j.snapshot.State = StateCancelled
	j.snapshot.FinishedAt = &now
	j.snapshot.Error = models.NewError(models.CodeCancelled, "Job was cancelled", nil)
	snapshot := j.snapshot
	m.mu.Unlock()
	m.emit(snapshot)
	j.finish()
}

func (j *job) finish() { j.doneOnce.Do(func() { close(j.done) }) }

type reporter struct {
	manager *Manager
	id      string
}

func (r reporter) Update(progress float64, message string) {
	if progress < 0 {
		progress = 0
	}
	if progress > 1 {
		progress = 1
	}
	r.manager.mu.Lock()
	j, ok := r.manager.jobs[r.id]
	if !ok || terminal(j.snapshot.State) {
		r.manager.mu.Unlock()
		return
	}
	j.snapshot.Progress = progress
	j.snapshot.Stage = message
	j.snapshot.Message = message
	snapshot := j.snapshot
	r.manager.mu.Unlock()
	r.manager.emit(snapshot)
}

func (m *Manager) Get(id string) (Snapshot, error) {
	m.mu.RLock()
	j, ok := m.jobs[id]
	if !ok {
		m.mu.RUnlock()
		return Snapshot{}, models.NewError(models.CodeJobNotFound, "Job was not found", map[string]any{"jobId": id})
	}
	snapshot := j.snapshot
	m.mu.RUnlock()
	return snapshot, nil
}

// Wait returns a terminal snapshot or the caller's context error. It does not
// consume the result, so repeated waits are safe.
func (m *Manager) Wait(ctx context.Context, id string) (Snapshot, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	m.mu.RLock()
	j, ok := m.jobs[id]
	m.mu.RUnlock()
	if !ok {
		return Snapshot{}, models.NewError(models.CodeJobNotFound, "Job was not found", map[string]any{"jobId": id})
	}
	select {
	case <-j.done:
		return m.Get(id)
	case <-ctx.Done():
		return Snapshot{}, ctx.Err()
	}
}

func (m *Manager) List() []Snapshot {
	m.mu.RLock()
	snapshots := make([]Snapshot, 0, len(m.jobs))
	for _, j := range m.jobs {
		snapshots = append(snapshots, j.snapshot)
	}
	m.mu.RUnlock()
	sort.Slice(snapshots, func(i, j int) bool {
		if snapshots[i].CreatedAt.Equal(snapshots[j].CreatedAt) {
			return snapshots[i].ID < snapshots[j].ID
		}
		return snapshots[i].CreatedAt.Before(snapshots[j].CreatedAt)
	})
	return snapshots
}

// Cancel is idempotent, including after a job reaches a terminal state.
func (m *Manager) Cancel(id string) (Snapshot, error) {
	m.mu.Lock()
	j, ok := m.jobs[id]
	if !ok {
		m.mu.Unlock()
		return Snapshot{}, models.NewError(models.CodeJobNotFound, "Job was not found", map[string]any{"jobId": id})
	}
	if terminal(j.snapshot.State) {
		snapshot := j.snapshot
		m.mu.Unlock()
		return snapshot, nil
	}
	j.cancel()
	now := time.Now().UTC()
	j.snapshot.State = StateCancelled
	j.snapshot.FinishedAt = &now
	j.snapshot.Error = models.NewError(models.CodeCancelled, "Job was cancelled", nil)
	snapshot := j.snapshot
	m.mu.Unlock()
	m.emit(snapshot)
	j.finish()
	return snapshot, nil
}

// Shutdown prevents submissions, cancels all work, and waits for every internal
// goroutine or for ctx to expire. Calling it repeatedly is safe.
func (m *Manager) Shutdown(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	m.mu.Lock()
	if !m.closed {
		m.closed = true
		m.cancel()
		for _, j := range m.jobs {
			if !terminal(j.snapshot.State) {
				j.cancel()
			}
		}
	}
	m.mu.Unlock()
	m.waitOnce.Do(func() {
		go func() {
			m.wg.Wait()
			close(m.done)
		}()
	})
	select {
	case <-m.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func terminal(state State) bool {
	return state == StateCompleted || state == StateFailed || state == StateCancelled
}

func (m *Manager) emit(snapshot Snapshot) {
	if m.callback == nil {
		return
	}
	defer func() { _ = recover() }()
	m.callback(snapshot)
}
