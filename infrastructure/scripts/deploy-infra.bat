@echo off
REM Deploy infrastructure files to VPS.
REM Run from the repo root after any change to n8n\docker-compose.yml or n8n\litellm-config.yaml.
REM See ADR-033.

set VPS=franciszek@185.25.149.174
set REMOTE=/opt/haxe-agents

echo Deploying docker-compose.yml...
scp n8n\docker-compose.yml %VPS%:%REMOTE%/docker-compose.yml
if %ERRORLEVEL% NEQ 0 (echo FAILED: docker-compose.yml & exit /b 1)

echo Deploying litellm-config.yaml...
scp n8n\litellm-config.yaml %VPS%:%REMOTE%/litellm-config.yaml
if %ERRORLEVEL% NEQ 0 (echo FAILED: litellm-config.yaml & exit /b 1)

echo.
echo Files deployed. If docker-compose.yml changed, recreate affected containers:
echo   ssh %VPS% "cd %REMOTE% ^&^& docker compose up -d litellm"
echo.
echo Then verify env vars reached the container:
echo   ssh %VPS% "docker exec litellm env ^| grep ANTHROPIC"
