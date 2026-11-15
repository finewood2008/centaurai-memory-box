# WANX workspace orchestration. Octop's project Makefile lives in octop/.
SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help all build build-frontend build-wheel format format-all lint lint-frontend typecheck typecheck-frontend test test-fast test-live check-all install install-dev install-hooks clean version

help:
	@echo "WANX workspace"
	@echo "  make all             Run the Octop ship bar"
	@echo "  make build           Build Octop dashboard and wheel"
	@echo "  make test            Run Octop tests"
	@echo "  make check-all       Run Octop and dashboard checks"

all:
	$(MAKE) -C octop all
build:
	$(MAKE) -C octop build
build-frontend:
	$(MAKE) -C octop build-frontend
build-wheel:
	$(MAKE) -C octop build-wheel
format:
	$(MAKE) -C octop format
format-all:
	$(MAKE) -C octop format-all
lint:
	$(MAKE) -C octop lint
lint-frontend:
	$(MAKE) -C octop lint-frontend
typecheck:
	$(MAKE) -C octop typecheck
typecheck-frontend:
	$(MAKE) -C octop typecheck-frontend
test:
	$(MAKE) -C octop test
test-fast:
	$(MAKE) -C octop test-fast
test-live:
	$(MAKE) -C octop test-live
check-all:
	$(MAKE) -C octop check-all
install install-dev:
	$(MAKE) -C octop install
install-hooks:
	$(MAKE) -C octop install-hooks
clean:
	$(MAKE) -C octop clean
version:
	$(MAKE) -C octop version
