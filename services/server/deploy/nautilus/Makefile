MAKEFILE_DIR := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
REPO_ROOT := $(abspath $(MAKEFILE_DIR)/../../../..)

BASE_IMAGE ?= memwal-relayer:runtime
IMAGE ?= memwal-relayer:nautilus
ENV_FILE ?= $(MAKEFILE_DIR)/runtime.env.example
RELAYER_URL ?= http://127.0.0.1:8000
PORT ?= 8000

.DEFAULT_GOAL := help

.PHONY: help
help:
	@echo "Targets:"
	@echo "  build-base   Build services/server/Dockerfile as $(BASE_IMAGE)"
	@echo "  build        Build the TEE wrapper image as $(IMAGE)"
	@echo "  run-local    Run the wrapper image with ENV_FILE=$(ENV_FILE)"
	@echo "  smoke        Check RELAYER_URL=$(RELAYER_URL)/health"

.PHONY: build-base
build-base:
	docker build \
		-f $(REPO_ROOT)/services/server/Dockerfile \
		-t $(BASE_IMAGE) \
		$(REPO_ROOT)/services/server

.PHONY: build
build: build-base
	docker build \
		-f $(MAKEFILE_DIR)/Containerfile \
		--build-arg BASE_IMAGE=$(BASE_IMAGE) \
		-t $(IMAGE) \
		$(REPO_ROOT)

.PHONY: run-local
run-local:
	docker run --rm \
		--env-file $(ENV_FILE) \
		-p $(PORT):8000 \
		$(IMAGE)

.PHONY: smoke
smoke:
	curl -fsS $(RELAYER_URL)/health
