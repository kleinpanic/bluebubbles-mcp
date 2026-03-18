# BlueBubbles MCP Server v2.0

A persistent HTTP/SSE MCP server exposing 20 tools over the BlueBubbles REST API. Runs as a launchd service on macOS, accessible over wg-teleport mesh.

## Architecture

```
Agent (broklein)
  mcporter (HTTP/SSE client)
    localhost:18800  <-- autossh LocalForward
      10.70.80.12:18791 (MCP HTTP/SSE, this process)
        http://localhost:1234 (BlueBubbles server)
          iMessage / SMS via macOS Messages.app
```

## Setup

### Collins (macOS)
```bash
cd ~/code/bluebubbles-mcp
npm install && npm run build

# Install launchd service
cp LaunchAgents/com.openclaw.bluebubbles-mcp.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.openclaw.bluebubbles-mcp.plist
```

Config via environment in plist:
- `BB_URL` — BlueBubbles server URL (default: `http://127.0.0.1:1234`)
- `BB_PASSWORD` — path to password file or raw password
- `MCP_BIND` — bind address (default: `10.70.80.12`)
- `MCP_PORT` — port (default: `18791`)
- `MCP_TRANSPORT` — `http` or `stdio` (default: `http`)

### Broklein (Linux)
```bash
# SSH tunnel via autossh
systemctl --user start openclaw-bb-mcp-forward

# mcporter config (~/.mcporter/mcporter.json)
{
  "servers": {
    "bluebubbles": {
      "type": "sse",
      "baseUrl": "http://127.0.0.1:18800/sse"
    }
  }
}
```

## Tools (20)

### Server
- **`bb_server_info`** — Health, version, `private_api`, `helper_connected`, iCloud account

### Contacts
- **`bb_contact_query`** `addresses: string[]` — Phone/email -> Apple Contacts record (name, emails, birthday). Canonical lookup.
- **`bb_list_contacts`** `search?: string` — Digit-normalized search across all contacts

### Handles
- **`bb_list_handles`** `limit, offset` — All iMessage/SMS handles
- **`bb_handle_query`** `addresses: string[]` — Filter handles by address (client-side; BB v1.9.9 ignores server filter)

### Chats
- **`bb_list_chats`** `limit, offset, sort` — All conversations
- **`bb_get_chat`** `guid` — Single chat with participants
- **`bb_create_chat`** `addresses[], message?, method?` — New conversation (private-api required)
- **`bb_delete_chat`** `guid` — Delete/archive
- **`bb_mark_read`** `guid` — Clear unread

### Messages
- **`bb_get_chat_messages`** `chat_guid, limit, sort, after?` — Message history
- **`bb_send_message`** `chat_guid, message, method?` — Send text. Bare +E164 auto-normalizes to `iMessage;-;+...`. Default method: `private-api`
- **`bb_send_attachment`** `chat_guid, attachment (base64), filename, mimeType` — Send file
- **`bb_get_attachment`** `guid, maxBytes?` — Download. <=200KB: inline base64. >200KB: `downloadUrl`
- **`bb_react_message`** `chatGuid, messageGuid, reaction` — Tapback. Named string required: `"love"`, `"like"`, `"dislike"`, `"laugh"`, `"emphasize"`, `"question"`, prefix `-` to remove. Integer aliases 2000-2005 mapped internally.
- **`bb_unsend_message`** `guid` — Unsend (private-api)
- **`bb_edit_message`** `guid, editedMessage, backwardsCompatibilityMessage?` — Edit message (private-api)
- **`bb_set_typing`** `guid, typing: boolean` — Typing indicator (private-api)

### Find My
- **`bb_find_my_devices`** — All iCloud devices with name, class, battery, location
- **`bb_find_my_friends`** — Find My friends with locations

## GUID Format

```
iMessage;-;+12673479614        direct iMessage (phone)
iMessage;-;user@icloud.com     direct iMessage (email)
SMS;-;+12673479614             SMS
iMessage;+;chat<id>            group iMessage
```

`bb_send_message` accepts bare `+E164` and auto-prefixes `iMessage;-;`.

## Private API Features

`bb_react_message`, `bb_unsend_message`, `bb_edit_message`, `bb_set_typing`, `bb_create_chat` require:
```json
{ "private_api": true, "helper_connected": true }
```
from `bb_server_info`. When unavailable, tools return `{ "ok": false, "reason": "private_api_unavailable" }`.

## Known Limitations (BB v1.9.9)

| Issue | Workaround |
|---|---|
| POST /handle/query ignores addresses filter | MCP fetches all handles, filters client-side |
| Large attachment downloads | Files >200KB return downloadUrl instead of inline base64 |
| POST /api/v1/chat returns 404 | Correct endpoint is /api/v1/chat/new |
| Reactions require named strings | Integer codes mapped via REACTION_MAP |

## Development

```bash
npm run build          # compile TypeScript

# Reload service after rebuild
launchctl stop com.openclaw.bluebubbles-mcp
launchctl start com.openclaw.bluebubbles-mcp
curl http://10.70.80.12:18791/health
```

## Changelog

### v2.0.0 (2026-03-17/18)
- HTTP/SSE persistent transport (was stdio per-call)
- Per-connection Server instances (fixes "Already connected" crash on reconnect)
- 7 -> 20 tools
- bb_contact_query: Apple Contacts lookup (fixes unknown contact name resolution)
- bb_handle_query: client-side address filter (BB v1.9.9 server filter broken)
- bb_send_message: auto-normalize bare +E164 to iMessage;-;+..., default private-api
- bb_send_attachment: multipart FormData upload with required name field
- bb_get_attachment: binary download with size-based inline/URL strategy
- bb_react_message: REACTION_MAP (integer aliases -> named strings)
- bb_edit_message: backwardsCompatibilityMessage + partIndex added to payload
- bb_create_chat: correct endpoint /api/v1/chat/new
- bb_find_my_devices: summarized response (was 86KB raw)

### v1.0.0 (2026-03-16)
- Initial: 7 tools, stdio transport
