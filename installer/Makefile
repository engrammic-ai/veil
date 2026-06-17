BINARY_NAME := veil-installer
CMD_PATH    := ./cmd/installer
DIST_DIR    := dist

VERSION     ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
COMMIT      := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
DATE        := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

LDFLAGS := -s -w \
	-X main.version=$(VERSION) \
	-X main.commit=$(COMMIT) \
	-X main.date=$(DATE)

GO      := go
GOFLAGS :=

.PHONY: build build-all test lint clean release

# Build for the current platform
build:
	mkdir -p $(DIST_DIR)
	$(GO) build $(GOFLAGS) -ldflags "$(LDFLAGS)" -o $(DIST_DIR)/$(BINARY_NAME) $(CMD_PATH)

# Cross-compile for all supported platforms
build-all: \
	build-linux-amd64-glibc \
	build-linux-amd64-musl \
	build-linux-arm64-glibc \
	build-linux-arm64-musl \
	build-darwin-amd64 \
	build-darwin-arm64 \
	build-windows-amd64

build-linux-amd64-glibc:
	mkdir -p $(DIST_DIR)
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
		$(GO) build $(GOFLAGS) -ldflags "$(LDFLAGS)" \
		-o $(DIST_DIR)/$(BINARY_NAME)-linux-amd64 $(CMD_PATH)

build-linux-amd64-musl:
	mkdir -p $(DIST_DIR)
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
		$(GO) build $(GOFLAGS) -ldflags "$(LDFLAGS) -extldflags '-static'" \
		-o $(DIST_DIR)/$(BINARY_NAME)-linux-amd64-musl $(CMD_PATH)

build-linux-arm64-glibc:
	mkdir -p $(DIST_DIR)
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 \
		$(GO) build $(GOFLAGS) -ldflags "$(LDFLAGS)" \
		-o $(DIST_DIR)/$(BINARY_NAME)-linux-arm64 $(CMD_PATH)

build-linux-arm64-musl:
	mkdir -p $(DIST_DIR)
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 \
		$(GO) build $(GOFLAGS) -ldflags "$(LDFLAGS) -extldflags '-static'" \
		-o $(DIST_DIR)/$(BINARY_NAME)-linux-arm64-musl $(CMD_PATH)

build-darwin-amd64:
	mkdir -p $(DIST_DIR)
	GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 \
		$(GO) build $(GOFLAGS) -ldflags "$(LDFLAGS)" \
		-o $(DIST_DIR)/$(BINARY_NAME)-darwin-amd64 $(CMD_PATH)

build-darwin-arm64:
	mkdir -p $(DIST_DIR)
	GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 \
		$(GO) build $(GOFLAGS) -ldflags "$(LDFLAGS)" \
		-o $(DIST_DIR)/$(BINARY_NAME)-darwin-arm64 $(CMD_PATH)

build-windows-amd64:
	mkdir -p $(DIST_DIR)
	GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
		$(GO) build $(GOFLAGS) -ldflags "$(LDFLAGS)" \
		-o $(DIST_DIR)/$(BINARY_NAME)-windows-amd64.exe $(CMD_PATH)

# Run all tests
test:
	$(GO) test ./...

# Run golangci-lint if available
lint:
	@if command -v golangci-lint >/dev/null 2>&1; then \
		golangci-lint run ./...; \
	else \
		echo "golangci-lint not found, skipping lint"; \
		$(GO) vet ./...; \
	fi

# Remove build artifacts
clean:
	rm -rf $(DIST_DIR)

# Build all platforms and generate SHA-256 checksums
release: build-all
	@echo "Generating checksums..."
	cd $(DIST_DIR) && sha256sum $(BINARY_NAME)-* > checksums.sha256
	@echo "Release artifacts:"
	@ls -lh $(DIST_DIR)
	@echo ""
	@cat $(DIST_DIR)/checksums.sha256
