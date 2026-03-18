# BlueBubbles MCP Server v2.0

MCP server for iMessage/SMS via BlueBubbles Private API. Runs as a persistent HTTP/SSE service on collins, reachable from broklein via SSH tunnel over the wg-teleport mesh.

## Architecture

```
broklein                         collins (10.70.80.12)
┌─────────────────────┐          ┌─────────────────────────────┐
│ mcporter             │          │ Node MCP service             │
│  baseUrl:            │  autossh │  (dist/index.js)             │
│  127.0.0.1:18800/sse ├─────────►│  bound to 10.70.80.12:18791  │
│                     │  tunnel  │                             │
│ user systemd:        │          │ launchd:                    │
│  openclaw-bb-mcp-    │          │  com.openclaw.bluebubbles-  │
│  forward.service     │          │  mcp.plist (KeepAlive)      │
└─────────────────────┘          └──────────┬──────────────────┘
                                            │ http://127.0.0.1:1234
                                  ┌─────────▼──────────────────┐
                                  │ BlueBubbles Server v1.9.9  │
                                  │ (macOS app, local only)    │
                                  └────────────────────────────┘
```

## Setup

### Prerequisites
- BlueBubbles server running on collins with Private API enabled
- wg-teleport mesh active (collins at `10.70.80.12`, broklein at `10.70.80.10`)
- Password at `/Users/collins/.config/bluebubbles/password`

### Collins — Start the MCP service
```bash
# Install launchd plist (already done)
launchctl load ~/Library/LaunchAgents/com.openclaw.bluebubbles-mcp.plist

# Check it's running
launchctl list | grep bluebubbles-mcp

# Logs
tail -f ~/Library/Logs/bluebubbles-mcp.log
```

### broklein — Start the SSH tunnel
```bash
# User systemd service (already installed + enabled)
systemctl --user start openclaw-bb-mcp-forward.service
systemctl --user status openclaw-bb-mcp-forward.service

# Verify tunnel
curl http://127.0.0.1:18800/health
```

### mcporter config (`~/.mcporter/mcporter.json`)
```json
"bluebubbles": {
  "description": "BlueBubbles iMessage/SMS MCP v2.0",
  "baseUrl": "http://127.0.0.1:18800/sse"
}
```

## Environment Variables (launchd plist)

| Variable | Value | Purpose |
|----------|-------|---------|
| `MCP_TRANSPORT` | `http` | HTTP/SSE mode (use `stdio` for legacy) |
| `MCP_PORT` | `18791` | Listening port on collins |
| `MCP_BIND` | `10.70.80.12` | Bind to wg-teleport mesh IP only |
| `BB_URL` | `http://127.0.0.1:1234` | BlueBubbles server |
| `BB_PASSWORD_FILE` | `/Users/collins/.config/bluebubbles/password` | Auth |

## Tools (20)

### Server
| Tool | Description |
|------|-------------|
| `bb_server_info` | Server health, version, `private_api` status, `helper_connected` |

### Chats
| Tool | Inputs | Description |
|------|--------|-------------|
| `bb_list_chats` | `limit`, `offset`, `sort` | List conversations with last message |
| `bb_get_chat` | `guid` | Single chat details |
| `bb_create_chat` | `addresses[]`, `message?`, `isGroup?`, `groupName?` | Start new conversation |
| `bb_delete_chat` | `guid` | Delete/archive chat locally |

### Messages
| Tool | Inputs | Description |
|------|--------|-------------|
| `bb_get_chat_messages` | `chat_guid`, `limit`, `sort`, `after?` | Chat message history |
| `bb_send_message` | `chat_guid`, `message`, `method?` | Send text (apple-script or private-api) |
| `bb_send_attachment` | `chat_guid`, `attachment` (base64), `filename`, `mimeType` | Send file/image |
| `bb_get_attachment` | `guid`, `download?` | Attachment metadata + optional base64 |
| `bb_react_message` | `chatGuid`, `messageGuid`, `reaction` | Tapback (private-api) |
| `bb_unsend_message` | `guid` | Unsend message (private-api) |
| `bb_edit_message` | `guid`, `editedMessage` | Edit message text (private-api) |
| `bb_set_typing` | `guid`, `typing` | Typing indicator (private-api) |
| `bb_mark_read` | `guid` | Mark chat as read |

### Contacts
| Tool | Inputs | Description |
|------|--------|-------------|
| `bb_list_contacts` | `search?`, `limit?` | Address book — search normalized (E.164 matches any format) |
| `bb_contact_query` | `addresses[]` | **Canonical lookup** — phone/email → full contact (BB normalizes) |

### Handles
| Tool | Inputs | Description |
|------|--------|-------------|
| `bb_list_handles` | `limit`, `offset` | All iMessage handles seen on this Mac |
| `bb_handle_query` | `addresses[]` | Addresses → handle objects + chat GUIDs |

### Find My
| Tool | Description |
|------|-------------|
| `bb_find_my_devices` | iCloud devices with location + battery |
| `bb_find_my_friends` | Find My friends and their locations |

## Contact Lookup Guide

### Number → Name (THE right way)
```bash
mcporter call bluebubbles.bb_contact_query \
  --args '{"addresses":["+12673479614"]}'
# Works with: "+12673479614", "(267) 347-9614", "2673479614" — BB normalizes
```

### Name → Chat GUID
```bash
# Step 1: get phone
mcporter call bluebubbles.bb_list_contacts --args '{"search":"Mom"}'

# Step 2: get chat GUID
mcporter call bluebubbles.bb_handle_query --args '{"addresses":["+14847070468"]}'
# Returns handle.chats[].guid
```

## Tapback Reaction IDs

| ID | Reaction | Remove |
|----|---------|--------|
| 2000 | ❤️ Love | -2000 |
| 2001 | 👍 Like | -2001 |
| 2002 | 👎 Dislike | -2002 |
| 2003 | 😂 Laugh | -2003 |
| 2004 | ‼️ Emphasis | -2004 |
| 2005 | ❓ Question | -2005 |

**Note:** Reactions require `private_api: true` and `helper_connected: true` in `bb_server_info`. Returns `{"ok":false,"reason":"private_api_unavailable"}` if helper is disconnected — handle gracefully.

## Private API Features

The following tools require the BlueBubbles helper app to be connected:
- `bb_react_message`, `bb_unsend_message`, `bb_edit_message`, `bb_set_typing`

All four return structured failure instead of throwing when unavailable:
```json
{
  "ok": false,
  "reason": "private_api_unavailable",
  "feature": "bb_react_message",
  "hint": "BlueBubbles helper app must be connected..."
}
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `mcporter call` hangs | SSH tunnel down | `systemctl --user restart openclaw-bb-mcp-forward` (stop + start if oc-guard blocks) |
| Port 18800 in use | Old SSH process lingering | `fuser -k 18800/tcp` then restart service |
| `Non-200 status code (404)` | Wrong baseUrl (missing `/sse`) | Ensure `baseUrl` ends with `/sse` |
| `private_api_unavailable` | BB helper not connected | Open BlueBubbles on collins, reconnect helper |
| Handle endpoints 404 | BB v1.9.9 quirk | Expected — `bb_list_handles` uses POST /handle/query internally |

## Development

```bash
# On collins
cd ~/code/bluebubbles-mcp

# Build
npm run build

# Run in stdio mode (dev/test)
BB_URL=http://127.0.0.1:1234 BB_PASSWORD_FILE=~/.config/bluebubbles/password \
  node dist/index.js

# Run in HTTP mode (production)
MCP_TRANSPORT=http MCP_PORT=18791 MCP_BIND=10.70.80.12 \
  BB_URL=http://127.0.0.1:1234 BB_PASSWORD_FILE=~/.config/bluebubbles/password \
  node dist/index.js

# Reload service after build
launchctl stop com.openclaw.bluebubbles-mcp && launchctl start com.openclaw.bluebubbles-mcp
```
