# Serverless OpenClaw — Operations Makefile
# Usage: make <target>
# Configuration: .env file (AWS_PROFILE, AWS_REGION)

include .env
export

ACCOUNT_ID := $(shell aws sts get-caller-identity --query Account --output text --profile $(AWS_PROFILE))
ECR_REPO   := $(ACCOUNT_ID).dkr.ecr.$(AWS_REGION).amazonaws.com/serverless-openclaw
USER_POOL  := ap-northeast-2_r6wLZ95dd
CLIENT_ID  := 1hgp8h9jico924p1atcr2c9ki9
CLUSTER    := serverless-openclaw

.PHONY: help build test lint deploy-all deploy-telegram deploy-web deploy-image deploy-image-soci deploy-mcp-secrets \
        user-create user-password user-list user-delete \
        task-list task-status task-stop task-stop-recent task-logs task-clean \
        telegram-webhook telegram-status \
        web-build web-upload cf-invalidate \
        cold-start cold-start-warm \
        status teardown

## ─── Help ────────────────────────────────────────────────────────────────────

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

## ─── Development ─────────────────────────────────────────────────────────────

build: ## TypeScript build (all packages)
	npm run build

test: ## Run unit tests
	npm run test

test-e2e: ## Run E2E tests
	npm run test:e2e

lint: ## Run linter
	npm run lint

## ─── Infrastructure ──────────────────────────────────────────────────────────

deploy-all: web-build ## Deploy all CDK stacks + web
	cd packages/cdk && npx cdk deploy --all --profile $(AWS_PROFILE) --require-approval never

deploy-mcp-secrets: ## Upload MCP_SECRET_* vars from .env to SSM Parameter Store
	@count=0; \
	while IFS= read -r line || [ -n "$$line" ]; do \
		case "$$line" in MCP_SECRET_*) ;; *) continue ;; esac; \
		name=$$(echo "$$line" | cut -d= -f1 | sed 's/^MCP_SECRET_//'); \
		value=$$(echo "$$line" | cut -d= -f2-); \
		ssmname=$$(echo "$$name" | tr '[:upper:]' '[:lower:]' | tr '_' '-'); \
		param="/serverless-openclaw/mcp-secrets/$$ssmname"; \
		echo "  Storing $$param"; \
		aws ssm put-parameter --name "$$param" --value "$$value" \
			--type SecureString --overwrite \
			--profile $(AWS_PROFILE) --region $(AWS_REGION) > /dev/null; \
		count=$$((count + 1)); \
	done < .env; \
	echo "✅ $$count MCP secret(s) stored in SSM"

deploy-stack: ## Deploy a specific stack (STACK=NetworkStack)
	cd packages/cdk && npx cdk deploy $(STACK) --profile $(AWS_PROFILE) --require-approval never

synth: ## CDK synth (generate CloudFormation)
	cd packages/cdk && npx cdk synth --profile $(AWS_PROFILE)

teardown: ## Destroy all CDK stacks (DANGEROUS)
	@echo "⚠️  This will delete ALL resources including data!"
	@read -p "Type 'yes' to confirm: " confirm && [ "$$confirm" = "yes" ] || exit 1
	cd packages/cdk && npx cdk destroy --all --profile $(AWS_PROFILE)

deploy-telegram: ## Deploy all stacks except WebStack (Telegram-only)
	cd packages/cdk && DEPLOY_WEB=false npx cdk deploy --all --profile $(AWS_PROFILE) --require-approval never

## ─── Container Image ─────────────────────────────────────────────────────────

deploy-image: ## Build and push Docker image to ECR
	docker build -f packages/container/Dockerfile -t serverless-openclaw .
	aws ecr get-login-password --region $(AWS_REGION) --profile $(AWS_PROFILE) | \
		docker login --username AWS --password-stdin $(ACCOUNT_ID).dkr.ecr.$(AWS_REGION).amazonaws.com
	docker tag serverless-openclaw:latest $(ECR_REPO):latest
	docker push $(ECR_REPO):latest
	@echo "✅ Image pushed: $(ECR_REPO):latest"
	@docker images serverless-openclaw:latest --format "Image size: {{.Size}}"

deploy-image-soci: ## Build, push image + SOCI index (Linux only)
	./scripts/deploy-image.sh --soci

## ─── Web UI ──────────────────────────────────────────────────────────────────

web-build: ## Build web UI with production env vars
	cd packages/web && npx vite build

deploy-web: web-build web-upload cf-invalidate ## Build + upload + invalidate cache
	@echo "✅ Web UI deployed"

web-upload: ## Upload web assets to S3
	$(eval BUCKET := $(shell aws cloudformation describe-stacks --stack-name WebStack \
		--query "Stacks[0].Outputs[?OutputKey=='WebBucketName'].OutputValue" \
		--output text --profile $(AWS_PROFILE) --region $(AWS_REGION)))
	aws s3 sync packages/web/dist/ s3://$(BUCKET)/ --delete \
		--profile $(AWS_PROFILE) --region $(AWS_REGION)

cf-invalidate: ## Invalidate CloudFront cache
	$(eval DIST_ID := $(shell aws cloudformation describe-stacks --stack-name WebStack \
		--query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" \
		--output text --profile $(AWS_PROFILE) --region $(AWS_REGION)))
	aws cloudfront create-invalidation --distribution-id $(DIST_ID) --paths "/*" \
		--profile $(AWS_PROFILE) --region $(AWS_REGION)

## ─── Cognito Users ───────────────────────────────────────────────────────────

user-create: ## Create Cognito user (EMAIL=user@example.com PASS=MyPass1!)
	@test -n "$(EMAIL)" || (echo "Usage: make user-create EMAIL=user@example.com PASS=MyPass1!" && exit 1)
	@test -n "$(PASS)" || (echo "Usage: make user-create EMAIL=user@example.com PASS=MyPass1!" && exit 1)
	aws cognito-idp sign-up \
		--client-id $(CLIENT_ID) \
		--username "$(EMAIL)" \
		--password "$(PASS)" \
		--user-attributes Name=email,Value=$(EMAIL) \
		--profile $(AWS_PROFILE) --region $(AWS_REGION)
	aws cognito-idp admin-confirm-sign-up \
		--user-pool-id $(USER_POOL) \
		--username "$(EMAIL)" \
		--profile $(AWS_PROFILE) --region $(AWS_REGION)
	aws cognito-idp admin-update-user-attributes \
		--user-pool-id $(USER_POOL) \
		--username "$(EMAIL)" \
		--user-attributes Name=email_verified,Value=true \
		--profile $(AWS_PROFILE) --region $(AWS_REGION)
	@echo "✅ User created: $(EMAIL)"

user-password: ## Change user password (EMAIL=user@example.com PASS=NewPass1!)
	@test -n "$(EMAIL)" || (echo "Usage: make user-password EMAIL=user@example.com PASS=NewPass1!" && exit 1)
	@test -n "$(PASS)" || (echo "Usage: make user-password EMAIL=user@example.com PASS=NewPass1!" && exit 1)
	aws cognito-idp admin-set-user-password \
		--user-pool-id $(USER_POOL) \
		--username "$(EMAIL)" \
		--password "$(PASS)" \
		--permanent \
		--profile $(AWS_PROFILE) --region $(AWS_REGION)
	@echo "✅ Password updated for: $(EMAIL)"

user-list: ## List Cognito users
	aws cognito-idp list-users \
		--user-pool-id $(USER_POOL) \
		--query "Users[].{Email:Attributes[?Name=='email'].Value|[0],Status:UserStatus,Created:UserCreateDate}" \
		--output table \
		--profile $(AWS_PROFILE) --region $(AWS_REGION)

user-delete: ## Delete Cognito user (EMAIL=user@example.com)
	@test -n "$(EMAIL)" || (echo "Usage: make user-delete EMAIL=user@example.com" && exit 1)
	@read -p "Delete user $(EMAIL)? (yes/no): " confirm && [ "$$confirm" = "yes" ] || exit 1
	aws cognito-idp admin-delete-user \
		--user-pool-id $(USER_POOL) \
		--username "$(EMAIL)" \
		--profile $(AWS_PROFILE) --region $(AWS_REGION)
	@echo "✅ User deleted: $(EMAIL)"

## ─── ECS Tasks ───────────────────────────────────────────────────────────────

task-list: ## List running ECS tasks
	@aws ecs list-tasks --cluster $(CLUSTER) \
		--profile $(AWS_PROFILE) --region $(AWS_REGION) \
		--query "taskArns" --output table 2>/dev/null || echo "No tasks running"

task-status: ## Show detailed Fargate container status
	@TASKS=$$(aws ecs list-tasks --cluster $(CLUSTER) \
		--profile $(AWS_PROFILE) --region $(AWS_REGION) \
		--query "taskArns[]" --output text 2>/dev/null); \
	if [ -z "$$TASKS" ]; then \
		echo "No running tasks"; \
	else \
		aws ecs describe-tasks --cluster $(CLUSTER) --tasks $$TASKS \
			--profile $(AWS_PROFILE) --region $(AWS_REGION) \
			--query "tasks[].{TaskArn:taskArn,Status:lastStatus,Health:healthStatus,StartedAt:startedAt,StoppedReason:stoppedReason,CPU:cpu,Memory:memory}" \
			--output table; \
		echo ""; \
		ENI=$$(aws ecs describe-tasks --cluster $(CLUSTER) --tasks $$TASKS \
			--profile $(AWS_PROFILE) --region $(AWS_REGION) \
			--query "tasks[0].attachments[0].details[?name=='networkInterfaceId'].value" --output text 2>/dev/null); \
		if [ -n "$$ENI" ] && [ "$$ENI" != "None" ]; then \
			IP=$$(aws ec2 describe-network-interfaces --network-interface-ids $$ENI \
				--profile $(AWS_PROFILE) --region $(AWS_REGION) \
				--query "NetworkInterfaces[0].Association.PublicIp" --output text 2>/dev/null); \
			echo "Public IP: $$IP"; \
		fi; \
	fi

task-stop: ## Stop all running ECS tasks
	@for task in $$(aws ecs list-tasks --cluster $(CLUSTER) \
		--profile $(AWS_PROFILE) --region $(AWS_REGION) \
		--query "taskArns[]" --output text 2>/dev/null); do \
		echo "Stopping $$task"; \
		aws ecs stop-task --cluster $(CLUSTER) --task "$$task" \
			--reason "Manual stop via Makefile" \
			--profile $(AWS_PROFILE) --region $(AWS_REGION) > /dev/null; \
	done
	@echo "✅ All tasks stopped"

task-stop-recent: ## Stop most recently started ECS task only
	@TASK=$$(aws ecs list-tasks --cluster $(CLUSTER) \
		--profile $(AWS_PROFILE) --region $(AWS_REGION) \
		--sort-by startedAt --query "taskArns[-1]" --output text 2>/dev/null); \
	if [ -z "$$TASK" ] || [ "$$TASK" = "None" ]; then \
		echo "No running tasks"; \
	else \
		echo "Stopping $$TASK"; \
		aws ecs stop-task --cluster $(CLUSTER) --task "$$TASK" \
			--reason "Manual stop (most recent)" \
			--profile $(AWS_PROFILE) --region $(AWS_REGION) > /dev/null; \
		echo "Stopped"; \
	fi

task-clean: ## Stop tasks + clean TaskState DynamoDB
	@$(MAKE) task-stop
	@for pk in $$(aws dynamodb scan --table-name serverless-openclaw-TaskState \
		--query "Items[].PK.S" --output text \
		--profile $(AWS_PROFILE) --region $(AWS_REGION) 2>/dev/null); do \
		echo "Deleting TaskState: $$pk"; \
		aws dynamodb delete-item --table-name serverless-openclaw-TaskState \
			--key "{\"PK\":{\"S\":\"$$pk\"}}" \
			--profile $(AWS_PROFILE) --region $(AWS_REGION); \
	done
	@echo "✅ Tasks stopped and TaskState cleaned"

task-logs: ## Tail ECS container logs
	aws logs tail /ecs/serverless-openclaw --follow \
		--profile $(AWS_PROFILE) --region $(AWS_REGION)

## ─── Telegram ────────────────────────────────────────────────────────────────

telegram-webhook: ## Register Telegram webhook
	@test -n "$(TELEGRAM_BOT_TOKEN)" || (echo "Set TELEGRAM_BOT_TOKEN in .env" && exit 1)
	$(eval API_URL := $(shell aws cloudformation describe-stacks --stack-name ApiStack \
		--query "Stacks[0].Outputs[?OutputKey=='HttpApiEndpoint'].OutputValue" \
		--output text --profile $(AWS_PROFILE) --region $(AWS_REGION)))
	$(eval SECRET := $(shell aws ssm get-parameter \
		--name /serverless-openclaw/secrets/telegram-webhook-secret \
		--with-decryption --query Parameter.Value --output text \
		--profile $(AWS_PROFILE) --region $(AWS_REGION)))
	TELEGRAM_BOT_TOKEN=$(TELEGRAM_BOT_TOKEN) \
	WEBHOOK_URL=$(API_URL)/telegram \
	TELEGRAM_SECRET_TOKEN=$(SECRET) \
	./scripts/setup-telegram-webhook.sh

telegram-status: ## Check Telegram webhook status
	@curl -s "https://api.telegram.org/bot$(TELEGRAM_BOT_TOKEN)/getWebhookInfo" | \
		python3 -m json.tool 2>/dev/null || \
		curl -s "https://api.telegram.org/bot$(TELEGRAM_BOT_TOKEN)/getWebhookInfo"

## ─── Cold Start Measurement ──────────────────────────────────────────────

cold-start: task-stop task-clean ## Measure cold start time (stops tasks first, then waits for idle)
	npx tsx scripts/cold-start-measure.ts

cold-start-warm: ## Measure warm start time (skip idle wait)
	npx tsx scripts/cold-start-measure.ts --no-wait

## ─── Status ──────────────────────────────────────────────────────────────────

status: ## Show deployment status overview
	@echo "=== Serverless OpenClaw Status ==="
	@echo ""
	@echo "Account: $(ACCOUNT_ID) / Region: $(AWS_REGION)"
	@echo ""
	@echo "--- CDK Stacks ---"
	@aws cloudformation list-stacks \
		--stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
		--query "StackSummaries[?starts_with(StackName,'Network')||starts_with(StackName,'Storage')||starts_with(StackName,'Auth')||starts_with(StackName,'Compute')||starts_with(StackName,'Api')||starts_with(StackName,'Web')].{Name:StackName,Status:StackStatus,Updated:LastUpdatedTime}" \
		--output table \
		--profile $(AWS_PROFILE) --region $(AWS_REGION) 2>/dev/null || echo "No stacks found"
	@echo ""
	@echo "--- ECS Tasks ---"
	@aws ecs list-tasks --cluster $(CLUSTER) \
		--query "taskArns" --output text \
		--profile $(AWS_PROFILE) --region $(AWS_REGION) 2>/dev/null || echo "No tasks"
	@echo ""
	@echo "--- Docker Image ---"
	@docker images serverless-openclaw:latest --format "Local: {{.Size}} ({{.CreatedAt}})" 2>/dev/null || echo "No local image"
	@echo ""
	@echo "--- Endpoints ---"
	@echo "Web:       https://dpw7grkq1m9vw.cloudfront.net"
	@echo "WebSocket: wss://wkw2xo5011.execute-api.$(AWS_REGION).amazonaws.com/prod"
	@echo "HTTP API:  https://2msk3i79v6.execute-api.$(AWS_REGION).amazonaws.com"
