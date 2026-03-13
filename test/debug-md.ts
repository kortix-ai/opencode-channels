import { markdownToTelegramV2 } from '../src/telegram-api.js';

const helpText = `**OpenCode Channels - Commands**

**Slash commands:**
* \`/help\` - Show this help
* \`/models\` - List available models
* \`/model <name>\` - Switch model
* \`/agents\` - List available agents
* \`/agent <name>\` - Switch agent
* \`/status\` - Show connection status
* \`/reset\` - Reset session
* \`/new\` - Start a fresh session
* \`/diff\` - Show recent changes
* \`/link\` - Share session link

Just send a message to start chatting with the agent.`;

const converted = markdownToTelegramV2(helpText);
console.log('=== CONVERTED ===');
console.log(converted);
console.log('=== END ===');

// Try sending it
const TOKEN = '8789735802:AAHl7ifYLJRs0_F8CQKd1_9Zat9Psfo26q8';
const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;

const resp = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    chat_id: 923868872,
    text: converted,
    parse_mode: 'MarkdownV2',
  }),
});
const data = await resp.json();
console.log('=== RESPONSE ===');
console.log(JSON.stringify(data, null, 2));
