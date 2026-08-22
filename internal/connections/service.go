package connections

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"sync"
	"time"

	"ducs-table/internal/credentials"
	"ducs-table/internal/database"
	"ducs-table/internal/extensions"
	"ducs-table/internal/federation"
	"ducs-table/internal/models"
	"ducs-table/internal/workspace"
)

type EventCallback func(ConnectionInfo)

type runtimeState struct {
	status     ConnectionStatus
	lastError  *models.AppError
	secretName string
}

type Service struct {
	db          *database.DB
	repo        connectionRepository
	credentials credentials.Store
	extensions  *extensions.Manager
	session     *federation.Session
	workspace   *workspace.Service
	onUpdate    EventCallback

	mu                  sync.RWMutex
	lifecycle           sync.Mutex
	runtime             map[string]runtimeState
	relations           map[string]models.ExternalRelationInfo
	connectionRelations map[string]map[string]struct{}
}

type connectionRepository interface {
	List(context.Context) ([]ConnectionInfo, error)
	Get(context.Context, string) (ConnectionInfo, error)
	Create(context.Context, ConnectionInfo) error
	Update(context.Context, ConnectionInfo) error
	Delete(context.Context, string) error
}

func NewService(db *database.DB, session *federation.Session, credentialStore credentials.Store, manager *extensions.Manager, ws *workspace.Service, callback EventCallback) *Service {
	if credentialStore == nil {
		credentialStore = credentials.NewUnavailableStore()
	}
	if manager == nil {
		manager = extensions.NewManager()
	}
	if ws == nil {
		ws = workspace.New(db)
	}
	return &Service{db: db, repo: NewRepository(db), credentials: credentialStore, extensions: manager, session: session, workspace: ws, onUpdate: callback,
		runtime: make(map[string]runtimeState), relations: make(map[string]models.ExternalRelationInfo), connectionRelations: make(map[string]map[string]struct{})}
}

func (s *Service) ListConnections(ctx context.Context) ([]ConnectionInfo, error) {
	connections, err := s.repo.List(ctx)
	if err != nil {
		return nil, err
	}
	for i := range connections {
		connections[i] = s.decorate(ctx, connections[i])
	}
	return connections, nil
}

func (s *Service) GetConnection(ctx context.Context, id string) (ConnectionInfo, error) {
	info, err := s.repo.Get(ctx, id)
	if err != nil {
		return ConnectionInfo{}, err
	}
	return s.decorate(ctx, info), nil
}

func (s *Service) decorate(ctx context.Context, info ConnectionInfo) ConnectionInfo {
	hasSecret, err := s.credentials.Has(ctx, info.ID)
	info.HasSecret = hasSecret
	s.mu.RLock()
	state, ok := s.runtime[info.ID]
	s.mu.RUnlock()
	if ok {
		info.Status, info.LastError = state.status, state.lastError
	} else {
		info.Status = StatusDisconnected
	}
	if err != nil && info.LastError == nil {
		info.LastError = models.NewError(models.CodeCredentialStoreUnavailable, "macOS Keychain is unavailable; connection passwords cannot be accessed", nil)
	}
	return info
}

func (s *Service) CreateConnection(ctx context.Context, request CreateConnectionRequest) (ConnectionInfo, error) {
	id, err := models.NewID()
	if err != nil {
		return ConnectionInfo{}, models.NewError(models.CodeDatabase, "Could not create a connection ID", nil)
	}
	now := nowUTC()
	info, err := validateConnection(ConnectionInfo{ID: id, Name: request.Name, Kind: request.Kind, CatalogName: request.CatalogName, Config: request.Config, AutoConnect: request.AutoConnect, CreatedAt: now, UpdatedAt: now})
	if err != nil {
		return ConnectionInfo{}, err
	}
	if err := validateRuntimeBounds(info); err != nil {
		return ConnectionInfo{}, err
	}
	if s.db != nil {
		var catalogExists bool
		if queryErr := s.db.SQL().QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE catalog_name = ?)`, info.CatalogName).Scan(&catalogExists); queryErr != nil {
			return ConnectionInfo{}, models.NewError(models.CodeDatabase, "Could not validate the SQL catalog alias", nil)
		}
		if catalogExists {
			return ConnectionInfo{}, models.NewError(models.CodeConnectionAlreadyExists, "The SQL catalog alias is already in use", map[string]any{"catalogName": info.CatalogName})
		}
	}
	secretWritten := false
	if request.Password != "" {
		if err := s.credentials.Set(ctx, id, credentials.Secret{Password: request.Password}); err != nil {
			return ConnectionInfo{}, err
		}
		secretWritten = true
	}
	if err := s.repo.Create(ctx, info); err != nil {
		if secretWritten {
			_ = s.credentials.Delete(context.Background(), id)
		}
		var appErr *models.AppError
		if errors.As(err, &appErr) {
			return ConnectionInfo{}, appErr
		}
		return ConnectionInfo{}, models.NewError(models.CodeDatabase, "Could not save connection metadata", nil)
	}
	s.setRuntime(id, runtimeState{status: StatusDisconnected})
	created := s.decorate(ctx, info)
	s.emit(created)
	return created, nil
}

func (s *Service) UpdateConnection(ctx context.Context, request UpdateConnectionRequest) (ConnectionInfo, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	current, err := s.repo.Get(ctx, request.ID)
	if err != nil {
		return ConnectionInfo{}, err
	}
	if request.CatalogName != "" {
		alias, aliasErr := normalizeCatalogName(request.CatalogName)
		if aliasErr != nil {
			return ConnectionInfo{}, aliasErr
		}
		if alias != current.CatalogName {
			return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "SQL catalog aliases cannot be changed after creation", map[string]any{"catalogName": current.CatalogName})
		}
	}
	attached := s.session != nil && s.session.IsAttached(current.ID)
	if s.status(current.ID) == StatusConnected || attached {
		if err := s.disconnectLocked(ctx, current.ID); err != nil {
			return ConnectionInfo{}, err
		}
	}
	current.Name, current.Config, current.AutoConnect, current.UpdatedAt = request.Name, request.Config, request.AutoConnect, nowUTC()
	validated, err := validateConnection(current)
	if err != nil {
		return ConnectionInfo{}, err
	}
	if err := validateRuntimeBounds(validated); err != nil {
		return ConnectionInfo{}, err
	}
	var previous credentials.Secret
	hadPrevious := false
	wroteSecret := false
	if request.Password != "" {
		hadPrevious, err = s.credentials.Has(ctx, current.ID)
		if err != nil {
			return ConnectionInfo{}, err
		}
		if hadPrevious {
			previous, err = s.credentials.Get(ctx, current.ID)
			if err != nil {
				var appErr *models.AppError
				if !errors.As(err, &appErr) || (appErr.Code != models.CodeCredentialReauthRequired && appErr.Code != models.CodeCredentialNotFound) {
					return ConnectionInfo{}, err
				}
				// The user explicitly supplied a replacement password. An old
				// credential tied to an earlier ad-hoc build cannot be rolled back,
				// but Set can replace its stale ACL below.
				hadPrevious = false
			}
		}
		if err := s.credentials.Set(ctx, current.ID, credentials.Secret{Password: request.Password}); err != nil {
			return ConnectionInfo{}, err
		}
		wroteSecret = true
	}
	if err := s.repo.Update(ctx, validated); err != nil {
		if wroteSecret {
			if hadPrevious {
				_ = s.credentials.Set(context.Background(), current.ID, previous)
			} else {
				_ = s.credentials.Delete(context.Background(), current.ID)
			}
		}
		return ConnectionInfo{}, err
	}
	s.setRuntime(current.ID, runtimeState{status: StatusDisconnected})
	updated := s.decorate(ctx, validated)
	s.emit(updated)
	return updated, nil
}

func (s *Service) DeleteConnection(ctx context.Context, id string) error {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	info, err := s.repo.Get(ctx, id)
	if err != nil {
		return err
	}
	if err := s.disconnectLocked(ctx, id); err != nil {
		return err
	}
	hadSecret, secretErr := s.credentials.Has(ctx, id)
	if secretErr != nil {
		return secretErr
	}
	if err := s.repo.Delete(ctx, id); err != nil {
		return err
	}
	if hadSecret {
		if err := s.credentials.Delete(ctx, id); err != nil {
			return models.NewError(models.CodeCredentialStoreUnavailable, "Connection metadata was removed, but its Keychain item could not be deleted", map[string]any{"connectionId": id})
		}
	}
	s.mu.Lock()
	delete(s.runtime, id)
	s.removeRelationsLocked(id)
	s.mu.Unlock()
	info.Status = StatusDisconnected
	s.emit(info)
	return nil
}

func (s *Service) TestConnection(ctx context.Context, request TestConnectionRequest) error {
	var info ConnectionInfo
	var err error
	if request.ID != "" {
		info, err = s.repo.Get(ctx, request.ID)
		if err != nil {
			return err
		}
		if request.Config.Postgres != nil || request.Config.Mongo != nil {
			info.Config = request.Config
		}
	} else {
		id, idErr := models.NewID()
		if idErr != nil {
			return models.NewError(models.CodeDatabase, "Could not create a connection test ID", nil)
		}
		info = ConnectionInfo{ID: id, Name: "Connection test", Kind: request.Kind, CatalogName: "test_" + strings.ReplaceAll(id[:8], "-", ""), Config: request.Config}
	}
	info, err = validateConnection(info)
	if err != nil {
		return err
	}
	if err := validateRuntimeBounds(info); err != nil {
		return err
	}
	if info.Kind == KindPostgres && info.Config.Postgres.ConnectTimeoutSeconds > 15 {
		copy := *info.Config.Postgres
		copy.ConnectTimeoutSeconds = 15
		info.Config.Postgres = &copy
	}
	if info.Kind == KindMongo && info.Config.Mongo.ConnectTimeoutSeconds > 15 {
		copy := *info.Config.Mongo
		copy.ConnectTimeoutSeconds = 15
		info.Config.Mongo = &copy
	}
	secret := credentials.Secret{Password: request.Password}
	if request.Password == "" && request.ID != "" {
		secret, err = s.optionalSecret(ctx, info.ID)
		if err != nil {
			return err
		}
	}
	testAlias := internalName("test", info.ID)
	return s.session.WithMutation(ctx, func(conn *sql.Conn) error {
		switch info.Kind {
		case KindPostgres:
			secretName, attachErr := attachPostgres(ctx, conn, s.extensions, info, secret, testAlias)
			if attachErr != nil {
				return attachErr
			}
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			return detachPostgres(cleanupCtx, conn, testAlias, secretName)
		case KindMongo:
			secretName, attachErr := attachMongo(ctx, conn, s.extensions, info, secret, testAlias)
			if attachErr != nil {
				return attachErr
			}
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			return detachMongo(cleanupCtx, conn, testAlias, secretName)
		default:
			return models.NewError(models.CodeInvalidArgument, "Connection provider is invalid", nil)
		}
	})
}

func (s *Service) Connect(ctx context.Context, id string) (ConnectionInfo, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	info, err := s.repo.Get(ctx, id)
	if err != nil {
		return ConnectionInfo{}, err
	}
	if s.status(id) == StatusConnected {
		return s.decorate(ctx, info), nil
	}
	s.setRuntime(id, runtimeState{status: StatusConnecting})
	connecting := s.decorate(ctx, info)
	s.emit(connecting)
	secret, err := s.optionalSecret(ctx, id)
	if err != nil {
		return s.failConnection(ctx, info, err)
	}
	var secretName string
	err = s.session.WithMutation(ctx, func(conn *sql.Conn) error {
		if s.session.IsAttached(id) {
			return nil
		}
		switch info.Kind {
		case KindPostgres:
			name, attachErr := attachPostgres(ctx, conn, s.extensions, info, secret, info.CatalogName)
			secretName = name
			if attachErr != nil {
				return attachErr
			}
		case KindMongo:
			name, attachErr := attachMongo(ctx, conn, s.extensions, info, secret, info.CatalogName)
			secretName = name
			if attachErr != nil {
				return attachErr
			}
		default:
			return models.NewError(models.CodeInvalidArgument, "Connection provider is invalid", nil)
		}
		s.session.MarkAttached(id, info.CatalogName)
		return nil
	})
	if err != nil {
		return s.failConnection(ctx, info, err)
	}
	s.setRuntime(id, runtimeState{status: StatusConnected, secretName: secretName})
	connected := s.decorate(ctx, info)
	s.emit(connected)
	return connected, nil
}

func (s *Service) Disconnect(ctx context.Context, id string) error {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	return s.disconnectLocked(ctx, id)
}

func (s *Service) disconnectLocked(ctx context.Context, id string) error {
	info, err := s.repo.Get(ctx, id)
	if err != nil {
		return err
	}
	state := s.runtimeState(id)
	if state.status == StatusDisconnected && !s.session.IsAttached(id) {
		return nil
	}
	err = s.session.WithMutation(ctx, func(conn *sql.Conn) error {
		if !s.session.IsAttached(id) {
			return nil
		}
		var detachErr error
		if info.Kind == KindPostgres {
			detachErr = detachPostgres(ctx, conn, info.CatalogName, state.secretName)
		} else {
			detachErr = detachMongo(ctx, conn, info.CatalogName, state.secretName)
		}
		if detachErr == nil {
			s.session.MarkDetached(id)
		}
		return detachErr
	})
	if err != nil {
		_, failErr := s.failConnection(ctx, info, err)
		return failErr
	}
	s.setRuntime(id, runtimeState{status: StatusDisconnected})
	s.mu.Lock()
	s.invalidateLocked(id)
	s.mu.Unlock()
	disconnected := s.decorate(ctx, info)
	s.emit(disconnected)
	return nil
}

func (s *Service) optionalSecret(ctx context.Context, id string) (credentials.Secret, error) {
	has, err := s.credentials.Has(ctx, id)
	if err != nil {
		return credentials.Secret{}, err
	}
	if !has {
		return credentials.Secret{}, nil
	}
	return s.credentials.Get(ctx, id)
}

func (s *Service) failConnection(ctx context.Context, info ConnectionInfo, cause error) (ConnectionInfo, error) {
	appErr := models.AsAppError(cause)
	if appErr.Code == models.CodeDatabase {
		appErr = models.NewError(models.CodeConnectionFailed, "The external database connection failed", nil)
	}
	s.setRuntime(info.ID, runtimeState{status: StatusError, lastError: appErr})
	failed := s.decorate(ctx, info)
	s.emit(failed)
	return failed, appErr
}

func (s *Service) status(id string) ConnectionStatus { return s.runtimeState(id).status }
func (s *Service) runtimeState(id string) runtimeState {
	s.mu.RLock()
	state, ok := s.runtime[id]
	s.mu.RUnlock()
	if !ok {
		state.status = StatusDisconnected
	}
	return state
}
func (s *Service) setRuntime(id string, state runtimeState) {
	s.mu.Lock()
	s.runtime[id] = state
	s.mu.Unlock()
}
func (s *Service) emit(info ConnectionInfo) {
	if s.onUpdate != nil {
		s.onUpdate(info)
	}
}

func (s *Service) AutoConnectIDs(ctx context.Context) ([]string, error) {
	infos, err := s.repo.List(ctx)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0)
	for _, info := range infos {
		if info.AutoConnect {
			ids = append(ids, info.ID)
		}
	}
	return ids, nil
}

func (s *Service) WithFederatedConn(ctx context.Context, fn func(*sql.Conn) error) error {
	return s.session.WithConn(ctx, fn)
}

func (s *Service) Shutdown() error {
	s.mu.RLock()
	infos := make(map[string]runtimeState, len(s.runtime))
	for id, state := range s.runtime {
		infos[id] = state
	}
	s.mu.RUnlock()
	connections, _ := s.repo.List(context.Background())
	byID := make(map[string]ConnectionInfo, len(connections))
	for _, info := range connections {
		byID[info.ID] = info
	}
	return s.session.Close(func(conn *sql.Conn) {
		for id, state := range infos {
			info, ok := byID[id]
			if !ok || state.status != StatusConnected {
				continue
			}
			_, _ = conn.ExecContext(context.Background(), "DETACH "+database.QuoteIdentifier(info.CatalogName))
			if state.secretName != "" {
				_, _ = conn.ExecContext(context.Background(), "DROP SECRET IF EXISTS "+database.QuoteIdentifier(state.secretName))
			}
		}
	})
}
