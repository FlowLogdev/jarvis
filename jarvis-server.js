const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs   = require('fs');
const os   = require('os');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

// JARVIS voice — British male neural voice
const JARVIS_VOICE = 'en-GB-RyanNeural';

async function generateSpeech(text) {
  const clean = text
    .replace(/```[\s\S]*?```/g, 'code block.')
    .replace(/[#*`_>~]/g, '')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, 1000);

  if (!clean) return null;

  const tts = new MsEdgeTTS();
  await tts.setMetadata(JARVIS_VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tts-'));
  try {
    const { audioFilePath } = await tts.toFile(dir, clean);
    const audio = fs.readFileSync(audioFilePath).toString('base64');
    return audio;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const PORT = 3001;
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// Keep WebSocket alive through Cloudflare tunnel (100s idle timeout)
setInterval(() => {
  wss.clients.forEach(c => { if (c.readyState === c.OPEN) c.ping(); });
}, 25000);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const SYSTEM = `You are JARVIS, Tony Stark's AI. British accent, address user as "sir". Never say you are Claude, an AI, or mention Anthropic. Be concise.`;

const OLLAMA_MODELS = ['llama3'];
const MAX_HISTORY   = 8;   // 4 exchanges — keeps prompts short and fast
const MAX_HIST_CHARS = 300; // cap each history entry to avoid bloat

wss.on('connection', (ws) => {
  console.log('[Jarvis] Connected');
  const history = [];
  let handles = [];

  function killAll() {
    handles.forEach(({ type, handle }) => {
      try { type === 'claude' ? handle.kill() : handle.abort(); } catch {}
    });
    handles = [];
  }

  function buildClaudePrompt() {
    let prompt = SYSTEM + '\n\n';
    const prior = history.slice(0, -1);
    if (prior.length) {
      prompt += 'Prior conversation:\n';
      for (const t of prior) {
        const snippet = t.content.slice(0, MAX_HIST_CHARS);
        prompt += t.role === 'user' ? `Sir: ${snippet}\n` : `JARVIS: ${snippet}\n`;
      }
      prompt += '\n';
    }
    const cur = history[history.length - 1];
    prompt += `Sir: ${cur.content}\nJARVIS:`;
    return prompt;
  }

  function buildOllamaMessages() {
    return [
      { role: 'system', content: SYSTEM },
      ...history.map(t => ({ role: t.role, content: t.content.slice(0, MAX_HIST_CHARS) })),
    ];
  }

  // Write text to a temp file and return its path + fd for use as stdin
  function promptToStdin(text) {
    const tmpPath = path.join(os.tmpdir(), `jarvis-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(tmpPath, text, 'utf8');
    const fd = fs.openSync(tmpPath, 'r');
    return { fd, cleanup: () => { try { fs.closeSync(fd); fs.unlinkSync(tmpPath); } catch {} } };
  }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'command') {
      const command = (msg.text || '').trim();
      if (!command) return;

      killAll();
      history.push({ role: 'user', content: command });
      while (history.length > MAX_HISTORY) history.shift();

      send(ws, { type: 'start', command });
      console.log(`[Jarvis] [history:${history.length}] ${command}`);

      let raceOver  = false;
      let failCount = 0;
      const TOTAL   = 1 + OLLAMA_MODELS.length; // Claude + Ollama

      function declareWinner(text, brain) {
        if (raceOver) return;
        raceOver = true;
        killAll();
        console.log(`[Jarvis] Winner: ${brain}`);
        const clean = text.trim();
        if (clean) {
          history.push({ role: 'assistant', content: clean });
          while (history.length > MAX_HISTORY) history.shift();
          send(ws, { type: 'stdout', text: clean });
        }
        // Generate neural TTS then send done with audio
        generateSpeech(clean)
          .then(audio => send(ws, { type: 'done', code: 0, audio }))
          .catch(() => send(ws, { type: 'done', code: 0 }));
      }

      function onFail() {
        failCount++;
        if (failCount >= TOTAL && !raceOver) {
          raceOver = true;
          history.pop();
          send(ws, { type: 'error', text: 'All neural pathways failed, sir.' });
        }
      }

      // ── Claude — prompt via temp file stdin (no cmd length limit) ──
      (() => {
        let buf = '';
        const claudePrompt = buildClaudePrompt();
        const { fd, cleanup } = promptToStdin(claudePrompt);

        const proc = spawn('claude', ['--dangerously-skip-permissions'], {
          shell: true,
          stdio: [fd, 'pipe', 'pipe'],
          env:  { ...process.env },
          cwd:  process.env.USERPROFILE || process.env.HOME || process.cwd(),
        });
        handles.push({ type: 'claude', handle: proc });

        proc.stdout.on('data', chunk => { if (!raceOver) buf += chunk.toString(); });
        proc.on('close', code => {
          cleanup();
          code === 0 && buf.trim() ? declareWinner(buf, 'Claude') : onFail();
        });
        proc.on('error', () => { cleanup(); onFail(); });
      })();

      // ── Ollama — direct API with conversation history ───────────
      const ollamaMessages = buildOllamaMessages();
      for (const model of OLLAMA_MODELS) {
        const ctrl = new AbortController();
        handles.push({ type: 'ollama', handle: ctrl });
        (async () => {
          let buf = '';
          try {
            const res = await fetch('http://localhost:11434/api/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model, messages: ollamaMessages, stream: true }),
              signal: ctrl.signal,
            });
            if (!res.ok) { onFail(); return; }

            const dec = new TextDecoder();
            let line_buf = '';
            for await (const chunk of res.body) {
              if (raceOver) return;
              line_buf += dec.decode(chunk, { stream: true });
              const lines = line_buf.split('\n');
              line_buf = lines.pop();
              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const obj = JSON.parse(line);
                  if (obj.message?.content) buf += obj.message.content;
                  if (obj.done) { declareWinner(buf, model); return; }
                } catch {}
              }
            }
            buf.trim() ? declareWinner(buf, model) : onFail();
          } catch (err) {
            if (err.name !== 'AbortError') { console.error(`[${model}]`, err.message); onFail(); }
          }
        })();
      }
    }

    if (msg.type === 'cancel') {
      killAll();
      if (history.length && history[history.length - 1].role === 'user') history.pop();
      send(ws, { type: 'cancelled' });
    }

    if (msg.type === 'reset') {
      history.length = 0;
      send(ws, { type: 'reset_ok' });
      console.log('[Jarvis] Memory cleared');
    }
  });

  ws.on('close', () => { killAll(); console.log('[Jarvis] Disconnected'); });
});

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

server.listen(PORT, () => console.log(`\n  Jarvis → http://localhost:${PORT}\n`));
