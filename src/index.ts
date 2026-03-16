#!/usr/bin/env node
/**
 * BlueBubbles MCP Server
 * iMessage/SMS via BlueBubbles Private API
 *
 * Tools:
 *   bb_server_info        — server health & version
 *   bb_list_chats         — list conversations
 *   bb_get_chat_messages  — messages in a chat
 *   bb_list_contacts      — address book contacts
 *   bb_send_message       — send iMessage/SMS
 *   bb_find_my_devices    — list iCloud Find My devices
 *   bb_find_my_location   — get device location
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "fs";

// ─── Config ────────────────────────────────────────────────────────────────────
const BB_URL = process.env.BB_URL ?? "http://127.0.0.1:1234";

// Read password from env or file
let BB_PASSWORD = process.env.BB_PASSWORD ?? "";
if (!BB_PASSWORD && process.env.BB_PASSWORD_FILE) {
  try {
    if (existsSync(process.env.BB_PASSWORD_FILE)) {
      BB_PASSWORD = readFileSync(process.env.BB_PASSWORD_FILE, "utf-8").trim();
    }
  } catch (err) {
    process.stderr.write("Failed to read password file: " + err + "\n");
  }
}

function apiUrl(path: string, params: Record<string, string | number> = {}): string {
  const url = new URL(`${BB_URL}${path}`);
  url.searchParams.set("password", BB_PASSWORD);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function bbGet<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const res = await fetch(apiUrl(path, params));
  if (!res.ok) {
    throw new Error(`BlueBubbles GET ${path} → HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

async function bbPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`BlueBubbles POST ${path} → HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

// ─── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS: Tool[] = [
  {
    name: "bb_server_info",
    description: "Get BlueBubbles server info, health, and version",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "bb_list_chats",
    description: "List all iMessage/SMS conversations (chats)",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max chats to return (default 25)",
        },
        offset: {
          type: "number",
          description: "Pagination offset (default 0)",
        },
        sort: {
          type: "string",
          description: "Sort order: 'lastmessage' (default) or 'id'",
          enum: ["lastmessage", "id"],
        },
      },
      required: [],
    },
  },
  {
    name: "bb_get_chat_messages",
    description: "Get messages from a specific chat by chat GUID",
    inputSchema: {
      type: "object",
      properties: {
        chat_guid: {
          type: "string",
          description: "The chat GUID (from bb_list_chats)",
        },
        limit: {
          type: "number",
          description: "Max messages to return (default 25)",
        },
        offset: {
          type: "number",
          description: "Pagination offset (default 0)",
        },
        sort: {
          type: "string",
          description: "'DESC' (newest first, default) or 'ASC'",
          enum: ["DESC", "ASC"],
        },
        after: {
          type: "number",
          description: "Return only messages after this Unix timestamp (ms)",
        },
      },
      required: ["chat_guid"],
    },
  },
  {
    name: "bb_list_contacts",
    description: "List address book contacts with phone numbers and emails",
    inputSchema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description: "Optional search query (name, phone, email)",
        },
        limit: {
          type: "number",
          description: "Max contacts to return (default 50)",
        },
      },
      required: [],
    },
  },
  {
    name: "bb_send_message",
    description: "Send an iMessage or SMS to a chat or phone number",
    inputSchema: {
      type: "object",
      properties: {
        chat_guid: {
          type: "string",
          description: "The chat GUID (preferred) or phone number / email address",
        },
        message: {
          type: "string",
          description: "Message text to send",
        },
        method: {
          type: "string",
          description: "Send method: 'apple-script' (default) or 'private-api'",
          enum: ["apple-script", "private-api"],
        },
      },
      required: ["chat_guid", "message"],
    },
  },
  {
    name: "bb_find_my_devices",
    description: "Find My - list all devices associated with iCloud account",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "bb_find_my_location",
    description: "Find My - get location of a specific device by ID",
    inputSchema: {
      type: "object",
      properties: {
        device_id: {
          type: "string",
          description: "The device ID from bb_find_my_devices",
        },
      },
      required: ["device_id"],
    },
  },
];

// ─── Tool handlers ─────────────────────────────────────────────────────────────
async function handleServerInfo(): Promise<string> {
  const data = await bbGet<Record<string, unknown>>("/api/v1/server/info");
  return JSON.stringify(data, null, 2);
}

async function handleListChats(args: Record<string, unknown>): Promise<string> {
  const limit = Number(args.limit ?? 25);
  const offset = Number(args.offset ?? 0);
  const sort = String(args.sort ?? "lastmessage");

  const data = await bbPost<Record<string, unknown>>("/api/v1/chat/query", {
    limit,
    offset,
    sort,
    withLastMessage: true,
  });

  interface Chat {
    guid: string;
    displayName?: string;
    participants?: Array<{ address?: string; firstName?: string; lastName?: string }>;
    lastMessage?: { text?: string; dateCreated?: number };
    groupName?: string;
    isArchived?: boolean;
  }
  const chats: Chat[] = (data.data as Chat[]) ?? [];
  const slim = chats.map((c) => ({
    guid: c.guid,
    displayName: c.displayName || c.groupName || "(no name)",
    participants: (c.participants ?? []).map(
      (p) => `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || p.address
    ),
    lastMessage: c.lastMessage?.text?.slice(0, 100),
    lastMessageAt: c.lastMessage?.dateCreated,
    isArchived: c.isArchived,
  }));
  return JSON.stringify({ total: data.metadata ?? chats.length, chats: slim }, null, 2);
}

async function handleGetChatMessages(args: Record<string, unknown>): Promise<string> {
  const chatGuid = String(args.chatGuid ?? args.chat_guid);
  const limit = Number(args.limit ?? 25);
  const offset = Number(args.offset ?? 0);
  const sort = String(args.sort ?? "DESC");
  const after = args.after ? Number(args.after) : undefined;

  const params: Record<string, string | number> = { limit, offset, sort };
  if (after !== undefined) params.after = after;

  const data = await bbGet<Record<string, unknown>>(
    `/api/v1/chat/${encodeURIComponent(chatGuid)}/message`,
    params
  );

  interface Message {
    guid: string;
    text?: string;
    handle?: { address?: string };
    isFromMe?: boolean;
    dateCreated?: number;
    hasAttachments?: boolean;
    error?: number;
    dateRead?: number;
  }
  const messages: Message[] = (data.data as Message[]) ?? [];
  const slim = messages.map((m) => ({
    guid: m.guid,
    text: m.text,
    from: m.isFromMe ? "me" : m.handle?.address,
    dateCreated: m.dateCreated,
    dateRead: m.dateRead,
    hasAttachments: m.hasAttachments,
    error: m.error,
  }));
  return JSON.stringify({ count: slim.length, messages: slim }, null, 2);
}

async function handleListContacts(args: Record<string, unknown>): Promise<string> {
  const limit = Number(args.limit ?? 50);

  const data = await bbGet<Record<string, unknown>>("/api/v1/contact", { limit });

  interface Contact {
    firstName?: string;
    lastName?: string;
    phoneNumbers?: Array<{ address?: string }>;
    emails?: Array<{ address?: string }>;
    displayName?: string;
  }
  const contacts: Contact[] = (data.data as Contact[]) ?? [];

  const search = args.search ? String(args.search).toLowerCase() : null;
  const filtered = search
    ? contacts.filter((c) => {
        const name = `${c.firstName ?? ""} ${c.lastName ?? ""}`.toLowerCase();
        const phones = (c.phoneNumbers ?? []).map((p) => p.address ?? "").join(" ");
        const emails = (c.emails ?? []).map((e) => e.address ?? "").join(" ");
        return name.includes(search) || phones.includes(search) || emails.includes(search);
      })
    : contacts;

  const slim = filtered.slice(0, limit).map((c) => ({
    name: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || c.displayName,
    phones: (c.phoneNumbers ?? []).map((p) => p.address),
    emails: (c.emails ?? []).map((e) => e.address),
  }));
  return JSON.stringify({ count: slim.length, contacts: slim }, null, 2);
}

async function handleSendMessage(args: Record<string, unknown>): Promise<string> {
  const chatGuid = String(args.chatGuid ?? args.chat_guid);
  const message = String(args.message);
  const method = String(args.method ?? "apple-script");

  const body: Record<string, unknown> = {
    chatGuid,
    message,
    method,
    subject: "",
    tempGuid: `temp-${Date.now()}`,
  };

  const data = await bbPost<Record<string, unknown>>("/api/v1/message/text", body);
  return JSON.stringify(data, null, 2);
}

async function handleFindMyDevices(): Promise<string> {
  const data = await bbGet<Record<string, unknown>>("/api/v1/findmy/devices");
  return JSON.stringify(data, null, 2);
}

async function handleFindMyLocation(args: Record<string, unknown>): Promise<string> {
  const deviceId = String(args.deviceId ?? args.device_id);
  const data = await bbGet<Record<string, unknown>>(
    `/api/v1/findmy/location/${encodeURIComponent(deviceId)}`
  );
  return JSON.stringify(data, null, 2);
}

// ─── Server setup ──────────────────────────────────────────────────────────────
const server = new Server(
  { name: "bluebubbles-mcp", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    let result: string;
    switch (name) {
      case "bb_server_info":
        result = await handleServerInfo();
        break;
      case "bb_list_chats":
        result = await handleListChats(args as Record<string, unknown>);
        break;
      case "bb_get_chat_messages":
        result = await handleGetChatMessages(args as Record<string, unknown>);
        break;
      case "bb_list_contacts":
        result = await handleListContacts(args as Record<string, unknown>);
        break;
      case "bb_send_message":
        result = await handleSendMessage(args as Record<string, unknown>);
        break;
      case "bb_find_my_devices":
        result = await handleFindMyDevices();
        break;
      case "bb_find_my_location":
        result = await handleFindMyLocation(args as Record<string, unknown>);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: result }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("BlueBubbles MCP server started\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
