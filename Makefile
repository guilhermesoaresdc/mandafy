SHELL := /bin/bash
.DEFAULT_GOAL := ajuda

COMPOSE := docker compose
COMPOSE_PROD := docker compose -f docker-compose.yml

.PHONY: ajuda up down logs build migrate seed psql redis-cli test check reset segredos

ajuda: ## Lista os alvos disponíveis
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

up: ## Sobe tudo em desenvolvimento (app, worker, postgres, redis, evolution)
	$(COMPOSE) up -d --build
	@echo "Painel: http://localhost:3000  ·  Evolution: http://localhost:8080"

down: ## Derruba os serviços, preservando os volumes
	$(COMPOSE) down

logs: ## Acompanha os logs do app e do worker
	$(COMPOSE) logs -f app worker

build: ## Reconstrói as imagens
	$(COMPOSE) build

migrate: ## Aplica as migrations pendentes
	$(COMPOSE) run --rm app npm run db:migrate

seed: ## Popula organização, admin, ritmos de envio e pipeline padrão
	$(COMPOSE) run --rm app npm run db:seed

psql: ## Abre um psql no banco
	$(COMPOSE) exec postgres psql -U $${POSTGRES_USER:-mandafy} -d $${POSTGRES_DB:-mandafy}

redis-cli: ## Abre um redis-cli
	$(COMPOSE) exec redis redis-cli

test: ## Roda os testes
	npm test

check: ## typecheck + lint + testes — o mesmo que a CI roda
	npm run typecheck && npm run lint && npm test

segredos: ## Gera SESSION_SECRET e ENCRYPTION_KEY para colar no .env
	@echo "SESSION_SECRET=$$(openssl rand -hex 32)"
	@echo "ENCRYPTION_KEY=$$(openssl rand -hex 32)"

reset: ## APAGA os volumes (banco, filas, sessões de WhatsApp). Irreversível.
	@echo "Isto apaga o banco, as filas e as sessões conectadas de WhatsApp."
	@echo "Os números precisarão ler o QR Code de novo."
	@read -p 'Digite APAGAR para confirmar: ' resposta; \
	 if [ "$$resposta" = "APAGAR" ]; then \
	   $(COMPOSE) down -v && echo "Volumes removidos."; \
	 else \
	   echo "Cancelado."; \
	 fi

producao: ## Sobe em modo produção (com Caddy e TLS, sem portas expostas)
	$(COMPOSE_PROD) up -d --build
