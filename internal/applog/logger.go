// Package applog provides the bounded, private diagnostic log used by the app.
package applog

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	defaultMaxBytes = int64(5 << 20)
	defaultBackups  = 3
	maxErrorBytes   = 4096
)

type Options struct {
	MaxBytes int64
	Backups  int
}

type Logger struct {
	path   string
	writer *rotatingFile
	logger *slog.Logger
}

func Open(path string, options Options) (*Logger, error) {
	path = filepath.Clean(path)
	if path == "." || path == "" {
		return nil, errors.New("applog: log path is empty")
	}
	maxBytes := options.MaxBytes
	if maxBytes <= 0 {
		maxBytes = defaultMaxBytes
	}
	backups := options.Backups
	if backups < 0 {
		backups = 0
	}
	if options.Backups == 0 {
		backups = defaultBackups
	}
	writer, err := openRotatingFile(path, maxBytes, backups)
	if err != nil {
		return nil, err
	}
	handler := slog.NewJSONHandler(writer, &slog.HandlerOptions{Level: slog.LevelInfo})
	return &Logger{path: path, writer: writer, logger: slog.New(handler)}, nil
}

func (l *Logger) Path() string {
	if l == nil {
		return ""
	}
	return l.path
}

func (l *Logger) Slog() *slog.Logger {
	if l == nil || l.logger == nil {
		return slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return l.logger
}

func (l *Logger) Info(event string, attrs ...any) {
	if l == nil || l.logger == nil {
		return
	}
	l.logger.Info(event, attrs...)
}

// Error writes one sanitized technical diagnostic and returns its correlation
// reference. redactValues are replaced before writing and should include local
// source paths or other context that does not belong in the diagnostic text.
func (l *Logger) Error(event string, err error, redactValues []string, attrs ...any) string {
	reference := NewReference()
	if l == nil || l.logger == nil {
		return ""
	}
	fields := make([]any, 0, len(attrs)+4)
	fields = append(fields, "error_ref", reference, "error_chain", SafeErrorChain(err, redactValues...))
	fields = append(fields, attrs...)
	failuresBefore := l.writer.Failures()
	l.logger.Error(event, fields...)
	if l.writer.Failures() != failuresBefore {
		return ""
	}
	return reference
}

func (l *Logger) Close() error {
	if l == nil || l.writer == nil {
		return nil
	}
	return l.writer.Close()
}

var referenceFallback atomic.Uint64

func NewReference() string {
	var value [8]byte
	if _, err := rand.Read(value[:]); err == nil {
		return hex.EncodeToString(value[:])
	}
	return fmt.Sprintf("%x-%x", time.Now().UTC().UnixNano(), referenceFallback.Add(1))
}

var (
	credentialAssignment = regexp.MustCompile(`(?i)(password|passwd|pwd|token|api[_-]?key|secret|authorization)\s*([:=])\s*([^\s,;]+)`)
	credentialURL        = regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]*://[^\s/@:]+:)([^\s/@]+)(@)`)
	bearerToken          = regexp.MustCompile(`(?i)\b(bearer\s+)[a-z0-9._~+/-]+=*`)
	rowContentLine       = regexp.MustCompile(`(?i)^\s*(original\s+line|row\s+data|row|record|value|sample|snippet|input)\s*:`)
	inlineRowContent     = regexp.MustCompile(`(?i)(original\s+line|row\s+data|record|value|sample|snippet|input)\s*:[^\r\n]*`)
	singleQuotedLiteral  = regexp.MustCompile(`'(?:[^']|'')*'`)
	doubleQuotedLiteral  = regexp.MustCompile(`"(?:[^"\\]|\\.)*"`)
)

// SafeErrorChain keeps driver categories and stage information while removing
// credentials, source paths, multiline row excerpts, and oversized payloads.
func SafeErrorChain(err error, redactValues ...string) string {
	if err == nil {
		return ""
	}
	parts := make([]string, 0, 4)
	for current, depth := err, 0; current != nil && depth < 12; depth++ {
		message := sanitizeError(current.Error(), redactValues...)
		if message != "" && (len(parts) == 0 || parts[len(parts)-1] != message) {
			parts = append(parts, message)
		}
		current = errors.Unwrap(current)
	}
	result := strings.Join(parts, " <- ")
	if len(result) > maxErrorBytes {
		result = result[:maxErrorBytes] + "…"
	}
	return result
}

func sanitizeError(value string, redactValues ...string) string {
	value = credentialURL.ReplaceAllString(value, `${1}[REDACTED]${3}`)
	value = credentialAssignment.ReplaceAllString(value, `${1}${2}[REDACTED]`)
	value = bearerToken.ReplaceAllString(value, `${1}[REDACTED]`)
	for _, hidden := range redactValues {
		if hidden != "" {
			value = strings.ReplaceAll(value, hidden, "[SOURCE]")
		}
	}
	value = inlineRowContent.ReplaceAllString(value, `${1}: [ROW CONTENT REDACTED]`)
	value = singleQuotedLiteral.ReplaceAllString(value, `'[VALUE REDACTED]'`)
	value = doubleQuotedLiteral.ReplaceAllString(value, `"[VALUE REDACTED]"`)
	lines := strings.Split(strings.ReplaceAll(value, "\r\n", "\n"), "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || rowContentLine.MatchString(line) {
			continue
		}
		if len(line) > 512 {
			line = line[:512] + "…"
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, " | ")
}

type rotatingFile struct {
	mu       sync.Mutex
	path     string
	maxBytes int64
	backups  int
	file     *os.File
	size     int64
	closed   bool
	failures atomic.Uint64
}

func openRotatingFile(path string, maxBytes int64, backups int) (*rotatingFile, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("applog: create log directory: %w", err)
	}
	writer := &rotatingFile{path: path, maxBytes: maxBytes, backups: backups}
	if err := writer.open(); err != nil {
		return nil, err
	}
	return writer, nil
}

func (w *rotatingFile) open() error {
	file, err := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("applog: open log: %w", err)
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return fmt.Errorf("applog: protect log: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return fmt.Errorf("applog: stat log: %w", err)
	}
	w.file = file
	w.size = info.Size()
	return nil
}

func (w *rotatingFile) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		w.failures.Add(1)
		return 0, os.ErrClosed
	}
	if w.size > 0 && w.size+int64(len(data)) > w.maxBytes {
		if err := w.rotate(); err != nil {
			w.failures.Add(1)
			return 0, err
		}
	}
	written, err := w.file.Write(data)
	w.size += int64(written)
	if err != nil {
		w.failures.Add(1)
	}
	return written, err
}

func (w *rotatingFile) rotate() (resultErr error) {
	closeErr := w.file.Close()
	w.file = nil
	if closeErr != nil {
		if reopenErr := w.open(); reopenErr != nil {
			return errors.Join(fmt.Errorf("applog: close before rotation: %w", closeErr), reopenErr)
		}
		return fmt.Errorf("applog: close before rotation: %w", closeErr)
	}
	defer func() {
		if resultErr == nil || w.file != nil {
			return
		}
		if reopenErr := w.open(); reopenErr != nil {
			resultErr = errors.Join(resultErr, reopenErr)
		}
	}()
	if w.backups > 0 {
		_ = os.Remove(fmt.Sprintf("%s.%d", w.path, w.backups))
		for index := w.backups - 1; index >= 1; index-- {
			oldPath := fmt.Sprintf("%s.%d", w.path, index)
			newPath := fmt.Sprintf("%s.%d", w.path, index+1)
			if err := os.Rename(oldPath, newPath); err != nil && !errors.Is(err, os.ErrNotExist) {
				return fmt.Errorf("applog: rotate backup: %w", err)
			}
		}
		if err := os.Rename(w.path, w.path+".1"); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("applog: rotate active log: %w", err)
		}
	} else if err := os.Remove(w.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("applog: truncate active log: %w", err)
	}
	return w.open()
}

func (w *rotatingFile) Failures() uint64 { return w.failures.Load() }

func (w *rotatingFile) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return nil
	}
	w.closed = true
	if w.file == nil {
		return errors.New("applog: log file is unavailable")
	}
	if err := w.file.Sync(); err != nil {
		_ = w.file.Close()
		return err
	}
	return w.file.Close()
}
