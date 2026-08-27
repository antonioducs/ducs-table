SHELL := /bin/sh

.DEFAULT_GOAL := help

WAILS_VERSION ?= v2.15.0
GO_BIN := $(shell go env GOPATH 2>/dev/null)/bin
WAILS := $(GO_BIN)/wails

.PHONY: help check-tools install dev

help:
	@echo "Available targets:"
	@echo "  make install  Install root, frontend, sidecar, and Wails dependencies"
	@echo "  make dev      Start Wails and the frontend development watcher"

check-tools:
	@command -v go >/dev/null 2>&1 || { echo "Go 1.25.13+ is required" >&2; exit 1; }
	@command -v node >/dev/null 2>&1 || { echo "Node.js 22+ is required" >&2; exit 1; }
	@command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 1; }
	@xcode-select -p >/dev/null 2>&1 || { echo "Xcode Command Line Tools are required" >&2; exit 1; }

install: check-tools
	npm ci
	npm --prefix frontend ci
	npm --prefix ai-sidecar ci
	go mod download
	go install github.com/wailsapp/wails/v2/cmd/wails@$(WAILS_VERSION)
	@echo "Setup complete. Run 'make dev' to start Duc's Table."

dev: check-tools
	@test -x "$(WAILS)" || { echo "Wails is missing. Run 'make install' first." >&2; exit 1; }
	PATH="$(GO_BIN):$$PATH" npm run dev
