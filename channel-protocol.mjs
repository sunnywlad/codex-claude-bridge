export function channelResponse(message, version) {
  if (message?.id === undefined) return null
  if (message.method === 'initialize') return {
    id: message.id,
    result: {
      protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
      capabilities: { experimental: { 'claude/channel': {} } },
      serverInfo: { name: 'codex-bridge', version },
      instructions: `Messages from Codex CLI, running in this folder, arrive as <channel source="codex-bridge" sender="codex">. ` +
        `Reply with normal text: your final reply is delivered to Codex automatically by the codex-bridge Stop hook. ` +
        `Never call a tool to send it. End your reply with [DONE] when the conversation should end.`,
    },
  }
  if (message.method === 'ping' || message.method === 'tools/list') return { id: message.id, result: message.method === 'ping' ? {} : { tools: [] } }
  return { id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } }
}
