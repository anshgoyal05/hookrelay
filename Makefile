.PHONY: dev test up down migrate verify lint typecheck format

up:
	docker compose -f infra/docker-compose.yml up -d

down:
	docker compose -f infra/docker-compose.yml down

dev:
	npm run dev

test:
	npm run test

lint:
	npm run lint

typecheck:
	npm run typecheck

format:
	npm run format

verify:
	npm run verify

migrate:
	npm run migrate
