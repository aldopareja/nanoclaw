---
name: setup-telegram
description: Run initial NanoClaw setup with Telegram as the messaging channel. Use when user wants to install dependencies, set up a Telegram bot, register their main channel, or start the background services. Triggers on "setup telegram", "install telegram", "configure nanoclaw with telegram", or first-time setup requests mentioning Telegram.
---

# NanoClaw Setup (Telegram)

Run setup steps automatically. Only pause when user action is required (BotFather token, configuration choices). Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for all other steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. creating a bot with BotFather, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## 1. Bootstrap (Node.js + Dependencies)

Run `bash setup.sh` and parse the status block.

- If NODE_OK=false → Node.js is missing or too old. Use `AskUserQuestion: Would you like me to install Node.js 22?` If confirmed:
  - macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm
  - After installing Node, re-run `bash setup.sh`
- If DEPS_OK=false → Read `logs/setup.log`. Try: delete `node_modules` and `package-lock.json`, re-run `bash setup.sh`. If native module build fails, install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), then retry.
- If NATIVE_OK=false → better-sqlite3 failed to load. Install build tools and re-run.
- Record PLATFORM and IS_WSL for later steps.

## 2. Check Environment

Run `npx tsx setup/index.ts --step environment` and parse the status block.

- If HAS_TELEGRAM_TOKEN=true → note that Telegram token exists, offer to skip step 6
- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record APPLE_CONTAINER and DOCKER values for step 3

## 3. Container Runtime

### 3a. Choose runtime

Check the preflight results for `APPLE_CONTAINER` and `DOCKER`, and the PLATFORM from step 1.

- PLATFORM=linux → Docker (only option)
- PLATFORM=macos + APPLE_CONTAINER=installed → Use `AskUserQuestion: Docker (default, cross-platform) or Apple Container (native macOS)?` If Apple Container, run `/convert-to-apple-container` now, then skip to 3c.
- PLATFORM=macos + APPLE_CONTAINER=not_found → Docker (default)

### 3a-rosetta. Rosetta 2 (Apple Silicon + Apple Container only)

If PLATFORM=macos and the chosen runtime is Apple Container, check for Rosetta 2:

```bash
/usr/bin/pgrep -q oahd && echo "ROSETTA_INSTALLED" || echo "ROSETTA_MISSING"
```

If ROSETTA_MISSING: Install Rosetta 2 (required for Apple Container's buildkit):

```bash
softwareupdate --install-rosetta --agree-to-license
```

Wait for installation to complete before proceeding to container build.

### 3a-network. Container Networking (Apple Container only)

Apple Container requires IP forwarding and NAT for containers to access the internet.

1. Check and enable IP forwarding:
```bash
sysctl net.inet.ip.forwarding
```
If the value is 0: Ask the user for permission, then:
```bash
sudo sysctl -w net.inet.ip.forwarding=1
```

2. Configure NAT. First detect the primary network interface:
```bash
route -n get default | awk '/interface:/{print $2}'
```
Then configure NAT (replace `<interface>` with detected interface):
```bash
echo "nat on <interface> from 192.168.64.0/24 to any -> (<interface>)" | sudo pfctl -ef -
```

Both commands require `sudo`. Use `AskUserQuestion` before running.

**Note:** These settings do not persist across reboots.

### 3a-docker. Install Docker

- DOCKER=running → continue to 3b
- DOCKER=installed_not_running → start Docker: `open -a Docker` (macOS) or `sudo systemctl start docker` (Linux). Wait 15s, re-check with `docker info`.
- DOCKER=not_found → Use `AskUserQuestion: Docker is required for running agents. Would you like me to install it?` If confirmed:
  - macOS: install via `brew install --cask docker`, then `open -a Docker` and wait for it to start. If brew not available, direct to Docker Desktop download at https://docker.com/products/docker-desktop
  - Linux: install with `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`. Note: user may need to log out/in for group membership.

### 3b. Apple Container conversion gate (if needed)

**If the chosen runtime is Apple Container**, you MUST check whether the source code has already been converted from Docker to Apple Container. Do NOT skip this step. Run:

```bash
grep -q "CONTAINER_RUNTIME_BIN = 'container'" src/container-runtime.ts && echo "ALREADY_CONVERTED" || echo "NEEDS_CONVERSION"
```

**If NEEDS_CONVERSION**, the source code still uses Docker as the runtime. You MUST run the `/convert-to-apple-container` skill NOW, before proceeding to the build step.

**If ALREADY_CONVERTED**, the code already uses Apple Container. Continue to 3c.

**If the chosen runtime is Docker**, no conversion is needed — Docker is the default. Continue to 3c.

### 3c. Build and test

Run `npx tsx setup/index.ts --step container -- --runtime <chosen>` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- Cache issue (stale layers): `docker builder prune -f` (Docker) or `container builder stop && container builder rm && container builder start` (Apple Container). Retry.
- Dockerfile syntax or missing files: diagnose from the log and fix, then retry.

**If TEST_OK=false but BUILD_OK=true:** The image built but won't run. Check logs — common cause is runtime not fully started. Wait a moment and retry the test.

## 4. Claude Authentication (No Script)

If HAS_ENV=true from step 2, read `.env` and check for `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. If present, confirm with user: keep or reconfigure?

AskUserQuestion: Claude subscription (Pro/Max) vs Anthropic API key?

**Subscription:** Tell user to run `claude setup-token` in another terminal, copy the token, add `CLAUDE_CODE_OAUTH_TOKEN=<token>` to `.env`. Do NOT collect the token in chat.

**API key:** Tell user to add `ANTHROPIC_API_KEY=<key>` to `.env`.

## 5. Apply Telegram Channel Code

**This step merges the Telegram channel implementation into the source code.** It must run BEFORE the service is started, so the binary includes Telegram support.

First, check if the Telegram skill has already been applied:

Read `.nanoclaw/state.yaml`. If `add-telegram` appears in the `applied_skills` list, skip to step 6. If the file does not exist or `add-telegram` is not listed, proceed.

**If NEEDS_APPLY:** Run the skills engine to apply the `/add-telegram` skill:

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-telegram
```

Parse the JSON output. If `success: true`, the Telegram channel code has been merged into `src/index.ts`, `src/config.ts`, and a new `src/channels/telegram.ts` has been added. The `grammy` npm dependency has been installed.

**If the apply fails with merge conflicts:** Read the intent files:
- `.claude/skills/add-telegram/modify/src/index.ts.intent.md`
- `.claude/skills/add-telegram/modify/src/config.ts.intent.md`

Fix the conflicts preserving the intent described in these files, then continue.

**If ALREADY_APPLIED:** Skip this step.

After applying, run tests and rebuild:

```bash
npm test && npm run build
```

If tests fail, check for common three-way merge issues:
- Missing `.catch()` handlers on promises
- Missing security validation calls (e.g., `resolveGroupFolderPath`)
- Missing `os` imports replaced with hardcoded strings

Fix any issues before continuing.

## 6. Telegram Authentication

If HAS_TELEGRAM_TOKEN=true from step 2, confirm with user: keep existing token or reconfigure?

AskUserQuestion: Do you already have a Telegram bot token from BotFather?

**If yes:** Ask user to paste the token.

**If no:** Walk the user through creating a bot:
1. Open Telegram and search for `@BotFather`
2. Send `/newbot`
3. Choose a display name (e.g., "Andy AI")
4. Choose a username (must end in `bot`, e.g., `andy_ai_bot`)
5. BotFather will reply with the token — ask user to paste it

Once you have the token, run:

```bash
npx tsx setup/index.ts --step telegram-auth -- --token TOKEN
```

(Bash timeout: 30000ms)

Parse the status block:
- If STATUS=success → record BOT_USERNAME for later steps
- If STATUS=failed → show the ERROR to user, ask them to verify the token and retry

**Important:** After this step, `.env` will contain `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ONLY=true`. This ensures WhatsApp will NOT be initialized at runtime (avoiding the crash from missing WhatsApp auth).

## 7. Configure Trigger and Assistant Name

AskUserQuestion: What name should the assistant use? (default: Andy)

AskUserQuestion: What trigger word should activate the bot? (default: @Andy)

The Telegram channel automatically translates `@bot_username` mentions (e.g., `@andy_ai_bot`) to the trigger pattern `@AssistantName`. In group chats, users can mention the bot naturally. In private chats, no trigger is needed.

AskUserQuestion: Main channel type — Private chat (DM with bot, recommended) or Group chat?

## 8. Get Chat ID

The bot needs to know which chat to respond in. Telegram bots cannot enumerate their chats, so the user must send a command to the bot.

**Tell the user:**
1. Open Telegram
2. Start a chat with the bot (for private chat) or add the bot to the group
3. **For groups:** Go to the bot's settings in BotFather, send `/mybots`, select the bot, choose "Bot Settings" → "Group Privacy" → **Turn OFF** (so the bot can see all messages)
4. Send `/chatid` to the bot in the chat you want to register
5. The bot will reply with the chat ID in format `tg:XXXXX` — ask the user to paste it here

**Important:** The bot must be running for `/chatid` to work. If the service hasn't started yet, run `npx tsx src/index.ts` in the background temporarily (Bash timeout: 10000ms, run in background), wait 5 seconds for the bot to connect, then ask the user to send `/chatid`. After getting the ID, stop the background process.

However, if the service step (step 10) hasn't run yet and we can't start the process, ask the user to provide the chat ID manually:
- For private chats: the user can find their Telegram user ID using `@userinfobot`
- For groups: the user can find the group ID using `@getmyid_bot` in the group

The JID format for registration is `tg:<chat_id>` (e.g., `tg:123456789` for a private chat, `tg:-1001234567890` for a group).

## 9. Register Channel

Run `npx tsx setup/index.ts --step register -- --jid "JID" --name "main" --trigger "@TriggerWord" --folder "main"` plus `--no-trigger-required` if private chat (DM), `--assistant-name "Name"` if not Andy.

## 10. Mount Allowlist

AskUserQuestion: Agent access to external directories?

**No:** `npx tsx setup/index.ts --step mounts -- --empty`
**Yes:** Collect paths/permissions. `npx tsx setup/index.ts --step mounts -- --json '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}'`

## 11. Start Service

If service already running: unload first.
- macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
- Linux: `systemctl --user stop nanoclaw` (or `systemctl stop nanoclaw` if root)

Run `npx tsx setup/index.ts --step service` and parse the status block.

**If FALLBACK=wsl_no_systemd:** WSL without systemd detected. Tell user they can either enable systemd in WSL (`echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf` then restart WSL) or use the generated `start-nanoclaw.sh` wrapper.

**If DOCKER_GROUP_STALE=true:** The user was added to the docker group after their session started — the systemd service can't reach the Docker socket. Ask user to run these two commands:

1. Immediate fix: `sudo setfacl -m u:$(whoami):rw /var/run/docker.sock`
2. Persistent fix (re-applies after every Docker restart):
```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/socket-acl.conf << 'EOF'
[Service]
ExecStartPost=/usr/bin/setfacl -m u:USERNAME:rw /var/run/docker.sock
EOF
sudo systemctl daemon-reload
```
Replace `USERNAME` with the actual username (from `whoami`). Run the two `sudo` commands separately — the `tee` heredoc first, then `daemon-reload`. After user confirms setfacl ran, re-run the service step.

**If SERVICE_LOADED=false:**
- Read `logs/setup.log` for the error.
- macOS: check `launchctl list | grep nanoclaw`. If PID=`-` and status non-zero, read `logs/nanoclaw.error.log`.
- Linux: check `systemctl --user status nanoclaw`.
- Re-run the service step after fixing.

## 12. Verify

Run `npx tsx setup/index.ts --step verify` and parse the status block.

**If STATUS=failed, fix each:**
- SERVICE=stopped → `npm run build`, then restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux) or `bash start-nanoclaw.sh` (WSL nohup)
- SERVICE=not_found → re-run step 11
- CREDENTIALS=missing → re-run step 4
- TELEGRAM_AUTH=not_found → re-run step 6
- REGISTERED_GROUPS=0 → re-run steps 8-9
- MOUNT_ALLOWLIST=missing → `npx tsx setup/index.ts --step mounts -- --empty`

**Note:** In Telegram-only mode (`TELEGRAM_ONLY=true`), `WHATSAPP_AUTH=not_found` is expected and does not indicate a problem. Only `TELEGRAM_AUTH` matters. The overall STATUS will be `success` as long as at least one channel auth is configured.

Tell user to test: send a message in their registered Telegram chat. Show: `tail -f logs/nanoclaw.log`

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common: wrong Node path (re-run step 11), missing `.env` (step 4), missing Telegram token (step 6).

**Container agent fails ("Claude Code process exited with code 1"):** Ensure the container runtime is running — `open -a Docker` (macOS Docker), `container system start` (Apple Container), or `sudo systemctl start docker` (Linux). Check container logs in `groups/main/logs/container-*.log`.

**No response to messages:** Check trigger pattern. Main channel with `--no-trigger-required` should respond to all messages. Check DB: `npx tsx setup/index.ts --step verify`. Check `logs/nanoclaw.log`.

**Bot not receiving group messages:** Make sure Group Privacy is disabled in BotFather: `/mybots` → select bot → "Bot Settings" → "Group Privacy" → Turn OFF.

**Token invalid:** Verify with `curl https://api.telegram.org/bot<TOKEN>/getMe`. If it returns `"ok": false`, create a new bot with BotFather.

**Unload service:** macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist` | Linux: `systemctl --user stop nanoclaw`
