// Package federation owns the single long-lived DuckDB connection on which
// external extensions are loaded and catalogs are attached.
package federation

import (
	"context"
	"database/sql"
	"errors"
	"sync"

	"ducs-table/internal/database"
)

type Session struct {
	db            *database.DB
	conn          *sql.Conn
	mu            sync.Mutex
	attachmentsMu sync.RWMutex
	attachments   map[string]string
	closed        bool
}

func New(ctx context.Context, db *database.DB) (*Session, error) {
	if db == nil {
		return nil, errors.New("federation: nil database")
	}
	conn, err := db.SQL().Conn(ctx)
	if err != nil {
		return nil, err
	}
	return &Session{db: db, conn: conn, attachments: make(map[string]string)}, nil
}

func (s *Session) WithConn(ctx context.Context, fn func(*sql.Conn) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.closed || s.conn == nil {
		return errors.New("federation: session is closed")
	}
	return fn(s.conn)
}

func (s *Session) WithTx(ctx context.Context, fn func(*sql.Tx) error) error {
	return s.WithConn(ctx, func(conn *sql.Conn) error { return s.db.WithTxOnConn(ctx, conn, fn) })
}

func (s *Session) WithMutation(ctx context.Context, fn func(*sql.Conn) error) error {
	return s.WithConn(ctx, func(conn *sql.Conn) error { return s.db.WithReservedMutation(ctx, conn, fn) })
}

func (s *Session) MarkAttached(connectionID, catalog string) {
	s.attachmentsMu.Lock()
	defer s.attachmentsMu.Unlock()
	s.attachments[connectionID] = catalog
}

func (s *Session) MarkDetached(connectionID string) {
	s.attachmentsMu.Lock()
	delete(s.attachments, connectionID)
	s.attachmentsMu.Unlock()
}
func (s *Session) IsAttached(connectionID string) bool {
	s.attachmentsMu.RLock()
	_, ok := s.attachments[connectionID]
	s.attachmentsMu.RUnlock()
	return ok
}

// Close serializes cleanup with every live scan. cleanup must not expose
// errors containing attach SQL or credentials; callers perform best-effort
// DETACH/DROP SECRET statements through this callback.
func (s *Session) Close(cleanup func(*sql.Conn)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	if cleanup != nil && s.conn != nil {
		cleanup(s.conn)
	}
	if s.conn == nil {
		return nil
	}
	err := s.conn.Close()
	s.conn = nil
	return err
}
