# BlueBubbles MCP Server

An MCP server for BlueBubbles — iMessage/SMS via Private API.

## Available Tools

| Tool | Description |
|------|-------------|
| bb_server_info | Server health & version |
| bb_list_chats | List conversations |
| bb_get_chat_messages | Get messages from a chat |
| bb_list_contacts | Address book contacts |
| bb_send_message | Send iMessage/SMS |
| bb_find_my_devices | List iCloud Find My devices |
| bb_find_my_friends | List Find My friends |

## Configuration

Set BB_PASSWORD_FILE environment variable:
export BB_PASSWORD_FILE=/path/to/password

## Find My Endpoints

- Devices: GET /api/v1/icloud/findmy/devices
- Friends: GET /api/v1/icloud/findmy/friends

## Links

- https://github.com/kleinpanic/bluebubbles-mcp
- https://bluebubbles.app/
