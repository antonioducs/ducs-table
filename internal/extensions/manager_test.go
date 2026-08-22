package extensions

import (
	"context"
	"database/sql"
	"errors"
	"reflect"
	"testing"

	"ducs-table/internal/models"
)

type fakeExecutor struct {
	statements []string
	loaded     bool
	installErr error
}

func (f *fakeExecutor) ExecContext(_ context.Context, statement string, _ ...any) (sql.Result, error) {
	f.statements = append(f.statements, statement)
	if statement[:4] == "LOAD" {
		if f.loaded {
			return nil, nil
		}
		return nil, errors.New("not installed")
	}
	if f.installErr != nil {
		return nil, f.installErr
	}
	f.loaded = true
	return nil, nil
}

func TestManagerCoreAndCommunityInstall(t *testing.T) {
	for _, test := range []struct {
		name string
		want []string
	}{
		{"postgres", []string{"LOAD postgres", "LOAD postgres", "INSTALL postgres", "LOAD postgres"}},
		{"mongo", []string{"LOAD mongo", "LOAD mongo", "INSTALL mongo FROM community", "LOAD mongo"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := &fakeExecutor{}
			if err := NewManager().Ensure(context.Background(), f, test.name); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(f.statements, test.want) {
				t.Fatalf("statements = %#v, want %#v", f.statements, test.want)
			}
		})
	}
}

func TestManagerLoadIsFastAndAllowlisted(t *testing.T) {
	f := &fakeExecutor{loaded: true}
	if err := NewManager().Ensure(context.Background(), f, "excel"); err != nil {
		t.Fatal(err)
	}
	if len(f.statements) != 1 || f.statements[0] != "LOAD excel" {
		t.Fatalf("statements = %#v", f.statements)
	}
	err := NewManager().Ensure(context.Background(), f, "httpfs; DROP TABLE x")
	var appErr *models.AppError
	if !errors.As(err, &appErr) || appErr.Code != models.CodeExtensionUnavailable {
		t.Fatalf("error = %#v", err)
	}
}

func TestManagerSanitizesExperimentalFailure(t *testing.T) {
	f := &fakeExecutor{installErr: errors.New("uri password=do-not-leak")}
	err := NewManager().Ensure(context.Background(), f, "mongo")
	var appErr *models.AppError
	if !errors.As(err, &appErr) || appErr.Code != models.CodeExperimentalExtensionUnavailable {
		t.Fatalf("error = %#v", err)
	}
	if appErr.Cause != nil {
		t.Fatal("sensitive extension cause was retained")
	}
}
