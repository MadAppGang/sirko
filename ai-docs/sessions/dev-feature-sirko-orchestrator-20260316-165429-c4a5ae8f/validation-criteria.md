# Validation Criteria

## Validation Types
- [x] CLI integration test — spawn real tmux session, verify detection + event flow
- [x] API endpoint test — start HTTP server for Twilio webhooks, test voice pipeline endpoints
- [x] Real Telegram bot test — connect to real Telegram API, verify message flow
- [ ] Unit tests only

## CLI Integration Test Configuration
- Deploy command: bun run start (from apps/orchestrator)
- Prerequisites: tmux installed, running
- Test script: spawn a test tmux session, send output, verify detection events fire
- Expected behavior: Orchestrator detects pane output and input-wait states correctly

## API Endpoint Test Configuration
- Deploy command: bun run start (voice-server)
- Test URL: http://localhost:3000/twilio/webhook
- Expected: Twilio webhook handler responds with valid TwiML

## Telegram Bot Test Configuration
- Prerequisites: TELEGRAM_BOT_TOKEN env var set, test supergroup with topics enabled
- Deploy command: bun run start (apps/orchestrator with telegram adapter)
- Expected: Bot responds in forum topic, creates topics for new sessions

## Evidence Collection
- Test output logs saved to validation/ directory
- Screenshots of Telegram messages (if browser test available)
- API response bodies saved as JSON
