package ai

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type RPCClient interface {
	Call(context.Context, string, any, any) error
	Close() error
}

type RequestHandler func(context.Context, string, json.RawMessage) (any, error)
type NotificationHandler func(string, json.RawMessage)

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

func (e *rpcError) Error() string { return e.Message }

type wireMessage struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *rpcError       `json:"error,omitempty"`
}

type pendingResponse struct {
	result json.RawMessage
	err    error
}

// JSONLPeer implements symmetric JSON-RPC over one-line JSON messages. It can
// serve sidecar-initiated tool.call requests while host calls are pending.
type JSONLPeer struct {
	input         io.ReadCloser
	output        io.WriteCloser
	handleRequest RequestHandler
	handleNotify  NotificationHandler
	writeMu       sync.Mutex
	mu            sync.Mutex
	pending       map[string]chan pendingResponse
	closed        chan struct{}
	closeOnce     sync.Once
	nextID        atomic.Uint64
	terminalErr   error
}

func NewJSONLPeer(input io.ReadCloser, output io.WriteCloser, requests RequestHandler, notifications NotificationHandler) *JSONLPeer {
	peer := &JSONLPeer{
		input: input, output: output, handleRequest: requests, handleNotify: notifications,
		pending: make(map[string]chan pendingResponse), closed: make(chan struct{}),
	}
	go peer.readLoop()
	return peer
}

func (p *JSONLPeer) Call(ctx context.Context, method string, params, result any) error {
	if strings.TrimSpace(method) == "" {
		return errors.New("ai rpc: method is required")
	}
	id := p.nextID.Add(1)
	idRaw := json.RawMessage(strconv.FormatUint(id, 10))
	key := string(idRaw)
	response := make(chan pendingResponse, 1)
	p.mu.Lock()
	select {
	case <-p.closed:
		err := p.terminalErr
		p.mu.Unlock()
		if err == nil {
			err = errors.New("AI sidecar is closed")
		}
		return err
	default:
	}
	p.pending[key] = response
	p.mu.Unlock()
	if err := p.write(wireMessage{ID: idRaw, Method: method, Params: marshalRaw(params)}); err != nil {
		p.removePending(key)
		return err
	}
	select {
	case <-ctx.Done():
		p.removePending(key)
		return ctx.Err()
	case reply := <-response:
		if reply.err != nil {
			return reply.err
		}
		if result == nil || len(reply.result) == 0 || string(reply.result) == "null" {
			return nil
		}
		if err := json.Unmarshal(reply.result, result); err != nil {
			return fmt.Errorf("decode AI sidecar response: %w", err)
		}
		return nil
	}
}

func (p *JSONLPeer) Close() error {
	p.fail(errors.New("AI sidecar was closed"))
	return nil
}

func (p *JSONLPeer) readLoop() {
	scanner := bufio.NewScanner(p.input)
	// Tool results and model events can be larger than Scanner's small default.
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := append([]byte(nil), scanner.Bytes()...)
		var message wireMessage
		if err := json.Unmarshal(line, &message); err != nil {
			continue
		}
		if len(message.ID) > 0 && message.Method == "" {
			p.resolve(message)
			continue
		}
		if message.Method == "" {
			continue
		}
		if len(message.ID) == 0 {
			if p.handleNotify != nil {
				p.handleNotify(message.Method, message.Params)
			}
			continue
		}
		go p.serve(message)
	}
	err := scanner.Err()
	if err == nil {
		err = errors.New("AI sidecar output closed")
	}
	p.fail(err)
}

func (p *JSONLPeer) serve(message wireMessage) {
	if p.handleRequest == nil {
		_ = p.write(wireMessage{ID: message.ID, Error: &rpcError{Code: -32601, Message: "Host method is not available"}})
		return
	}
	result, err := p.handleRequest(context.Background(), message.Method, message.Params)
	if err != nil {
		_ = p.write(wireMessage{ID: message.ID, Error: &rpcError{Code: -32000, Message: safeError(err)}})
		return
	}
	_ = p.write(wireMessage{ID: message.ID, Result: marshalRaw(result)})
}

func (p *JSONLPeer) resolve(message wireMessage) {
	key := string(message.ID)
	p.mu.Lock()
	response := p.pending[key]
	delete(p.pending, key)
	p.mu.Unlock()
	if response == nil {
		return
	}
	if message.Error != nil {
		message.Error.Message = RedactString(message.Error.Message)
		response <- pendingResponse{err: message.Error}
		return
	}
	response <- pendingResponse{result: message.Result}
}

func (p *JSONLPeer) write(message wireMessage) error {
	encoded, err := json.Marshal(message)
	if err != nil {
		return err
	}
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	select {
	case <-p.closed:
		return errors.New("AI sidecar is closed")
	default:
	}
	_, err = p.output.Write(append(encoded, '\n'))
	return err
}

func (p *JSONLPeer) removePending(key string) {
	p.mu.Lock()
	delete(p.pending, key)
	p.mu.Unlock()
}

func (p *JSONLPeer) fail(err error) {
	p.closeOnce.Do(func() {
		p.mu.Lock()
		p.terminalErr = err
		pending := p.pending
		p.pending = make(map[string]chan pendingResponse)
		close(p.closed)
		p.mu.Unlock()
		_ = p.input.Close()
		_ = p.output.Close()
		for _, response := range pending {
			response <- pendingResponse{err: err}
		}
	})
}

func marshalRaw(value any) json.RawMessage {
	if value == nil {
		return json.RawMessage(`null`)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage(`null`)
	}
	return encoded
}

type ProcessTransport struct {
	Stdout io.ReadCloser
	Stdin  io.WriteCloser
	Stderr io.ReadCloser
	Wait   func() error
}

type ProcessStarter interface {
	Start(context.Context) (ProcessTransport, error)
}

type ExecStarter struct {
	SidecarPath string
	DataDir     string
	NodeBinary  string
}

func (s ExecStarter) Start(ctx context.Context) (ProcessTransport, error) {
	sidecarPath := s.SidecarPath
	if sidecarPath == "" {
		var err error
		sidecarPath, err = ResolveSidecarPath()
		if err != nil {
			return ProcessTransport{}, err
		}
	}
	node := s.NodeBinary
	if node == "" {
		node = resolveNodeBinary(sidecarPath)
	}
	command := exec.CommandContext(ctx, node, sidecarPath)
	command.Env = sidecarEnvironment(s.DataDir)
	stdin, err := command.StdinPipe()
	if err != nil {
		return ProcessTransport{}, err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return ProcessTransport{}, err
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		return ProcessTransport{}, err
	}
	if err := command.Start(); err != nil {
		return ProcessTransport{}, fmt.Errorf("start AI sidecar: %w", err)
	}
	return ProcessTransport{Stdout: stdout, Stdin: stdin, Stderr: stderr, Wait: command.Wait}, nil
}

func resolveNodeBinary(sidecarPath string) string {
	if explicit := strings.TrimSpace(os.Getenv("DUCS_AI_NODE")); explicit != "" {
		return explicit
	}
	// Packaged layout: Resources/ai-sidecar/dist/index.js and the bundled
	// runtime at Resources/ai-sidecar/node. Development intentionally falls
	// back to the Node executable on PATH.
	bundled := filepath.Join(filepath.Dir(filepath.Dir(sidecarPath)), "node")
	if info, err := os.Stat(bundled); err == nil && !info.IsDir() {
		return bundled
	}
	return "node"
}

// Supervisor starts the sidecar lazily and keeps process details behind the
// RPCClient interface used by Service.
type Supervisor struct {
	ctx           context.Context
	starter       ProcessStarter
	requests      RequestHandler
	notifications NotificationHandler
	mu            sync.Mutex
	peer          *JSONLPeer
	closed        bool
}

func NewSupervisor(ctx context.Context, starter ProcessStarter, requests RequestHandler, notifications NotificationHandler) *Supervisor {
	return &Supervisor{ctx: ctx, starter: starter, requests: requests, notifications: notifications}
}

func (s *Supervisor) Call(ctx context.Context, method string, params, result any) error {
	peer, err := s.ensure()
	if err != nil {
		return err
	}
	return peer.Call(ctx, method, params, result)
}

func (s *Supervisor) ensure() (*JSONLPeer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, errors.New("AI runtime is shutting down")
	}
	if s.peer != nil {
		return s.peer, nil
	}
	if s.starter == nil {
		return nil, errors.New("AI sidecar is not configured")
	}
	transport, err := s.starter.Start(s.ctx)
	if err != nil {
		return nil, err
	}
	peer := NewJSONLPeer(transport.Stdout, transport.Stdin, s.requests, s.notifications)
	s.peer = peer
	if transport.Stderr != nil {
		go func() { _, _ = io.Copy(io.Discard, transport.Stderr) }()
	}
	if transport.Wait != nil {
		go func() {
			err := transport.Wait()
			if err == nil {
				err = errors.New("AI sidecar exited")
			}
			peer.fail(err)
			s.mu.Lock()
			if s.peer == peer && !s.closed {
				s.peer = nil
			}
			s.mu.Unlock()
		}()
	}
	return peer, nil
}

func (s *Supervisor) Close() error {
	s.mu.Lock()
	s.closed = true
	peer := s.peer
	s.mu.Unlock()
	if peer == nil {
		return nil
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var ignored any
	_ = peer.Call(shutdownCtx, "shutdown", map[string]any{}, &ignored)
	return peer.Close()
}

func ResolveSidecarPath() (string, error) {
	if explicit := strings.TrimSpace(os.Getenv("DUCS_AI_SIDECAR")); explicit != "" {
		return filepath.Abs(explicit)
	}
	candidates := make([]string, 0, 4)
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(cwd, "ai-sidecar", "dist", "index.js"))
	}
	if executable, err := os.Executable(); err == nil {
		dir := filepath.Dir(executable)
		candidates = append(candidates,
			filepath.Join(dir, "ai-sidecar", "dist", "index.js"),
			filepath.Join(dir, "Resources", "ai-sidecar", "dist", "index.js"),
			filepath.Join(dir, "..", "Resources", "ai-sidecar", "dist", "index.js"),
		)
	}
	for _, candidate := range candidates {
		absolute, _ := filepath.Abs(candidate)
		if info, err := os.Stat(absolute); err == nil && !info.IsDir() {
			return absolute, nil
		}
	}
	return "", errors.New("AI sidecar bundle was not found")
}

func sidecarEnvironment(dataDir string) []string {
	// Deliberately do not inherit OPENAI_*, ANTHROPIC_*, database URLs, or
	// other ambient secrets. Authentication is performed inside the isolated
	// provider profiles under DUCS_AI_HOME.
	allowed := []string{"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"}
	if runtime.GOOS == "windows" {
		allowed = append(allowed, "SystemRoot", "ComSpec", "PATHEXT")
	}
	environment := make([]string, 0, len(allowed)+1)
	for _, key := range allowed {
		if value, ok := os.LookupEnv(key); ok {
			environment = append(environment, key+"="+value)
		}
	}
	if dataDir != "" {
		environment = append(environment, "DUCS_AI_HOME="+dataDir)
	}
	return environment
}
