const isValidToken = (t) => {
  const token = t.trim();
  return /^[\w-]{24,}\.[\w-]{6}\.[\w-]{27,}(\.[\w-]{27,})?$/.test(token) ||
         /^mfa\.[A-Za-z0-9_-]{84}$/.test(token);
};

const fetchUsername = async (token) => {
  try {
    const res = await fetch('https://discord.com/api/v9/users/@me', {
      headers: { 'Authorization': token }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.username;
  } catch {
    return null;
  }
};

const delay = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = (base = 900, variation = 800) => delay(base + Math.random() * variation);

class VCJoiner {
  constructor(token, guildId, channelId) {
    this.token = token.trim();
    this.guildId = guildId;
    this.channelId = channelId;
    this.options = { camera: false, mic: false, deafen: false, stream: false };
    this.ws = null;
    this.heartbeat = null;
    this.connected = false;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json');
      this.ws = ws;
      const timeout = setTimeout(() => reject(new Error('Gateway timeout')), 15000);

      ws.onmessage = e => {
        const p = JSON.parse(e.data);
        if (p.op === 10) {
          clearTimeout(timeout);
          this.heartbeat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: null })), p.d.heartbeat_interval);
          ws.send(JSON.stringify({
            op: 2,
            d: {
              token: this.token,
              properties: { $os: "Windows", $browser: "Chrome", $device: "pc" },
              intents: 0
            }
          }));
          setTimeout(() => {
            this._sendVoiceState();
            this.connected = true;
            resolve();
          }, 2000);
        }
      };
      ws.onerror = () => reject(new Error('WebSocket error'));
      ws.onclose = () => this.connected = false;
    });
  }

  _sendVoiceState() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      op: 4,
      d: {
        guild_id: this.guildId,
        channel_id: this.channelId,
        self_mute: !this.options.mic,
        self_deaf: this.options.deafen,
        self_video: this.options.camera,
        self_stream: this.options.stream
      }
    }));
  }

  updateSettings(opts) {
    this.options = { ...this.options, ...opts };
    this._sendVoiceState();
  }

  disconnect() {
    if (this.ws) {
      this.ws.send(JSON.stringify({
        op: 4,
        d: { guild_id: this.guildId, channel_id: null, self_mute: true, self_deaf: false }
      }));
      setTimeout(() => this.ws?.close(), 500);
    }
    clearInterval(this.heartbeat);
    this.connected = false;
  }
}

class App {
  constructor() {
    this.tokens = new Set();
    this.clients = new Map();
    this.usernames = new Map();
    this.isRunning = false;

    this.el = {
      tokenInput: document.getElementById('tokenInput'),
      uploadBtn: document.getElementById('uploadBtn'),
      addBtn: document.getElementById('addBtn'),
      fileInput: document.getElementById('fileInput'),
      tokenList: document.getElementById('tokenList'),
      emptyState: document.getElementById('emptyState'),
      guildId: document.getElementById('guildId'),
      channelId: document.getElementById('channelId'),
      cam: document.getElementById('cam'),
      mic: document.getElementById('mic'),
      deafen: document.getElementById('deafen'),
      stream: document.getElementById('stream'),
      joinBtn: document.getElementById('joinBtn'),
      leaveBtn: document.getElementById('leaveBtn'),
      progress: document.getElementById('progress'),
      log: document.getElementById('log')
    };

    this.bindEvents();
  }

  log(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.textContent = `[${time}] ${msg}`;
    this.el.log.appendChild(line);
    this.el.log.scrollTop = this.el.log.scrollHeight;
  }

  getSettings() {
    return {
      camera: this.el.cam.checked,
      mic: this.el.mic.checked,
      deafen: this.el.deafen.checked,
      stream: this.el.stream.checked
    };
  }

  async addTokensFromText(inputValue) {
    if (!inputValue.trim()) return 0;
    const lines = inputValue.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let addedCount = 0;

    for (let token of lines) {
      if (!isValidToken(token)) {
        this.log(`無効なトークン: ${token.slice(0,20)}...`, 'error');
        continue;
      }
      if (this.tokens.has(token)) {
        this.log(`重複スキップ: ${token.slice(0,20)}...`, 'info');
        continue;
      }

      this.tokens.add(token);
      const username = await fetchUsername(token) || `不明 (${token.slice(0,8)}...)`;
      this.usernames.set(token, username);
      addedCount++;
    }

    this.renderTokenList();
    if (addedCount > 0) {
      this.el.tokenInput.value = '';
      this.log(`トークンを ${addedCount} 個追加 → @${[...this.usernames.values()].join(', @')}`, 'success');
    }
    return addedCount;
  }

  renderTokenList() {
    this.el.tokenList.innerHTML = '';
    if (this.tokens.size === 0) {
      this.el.emptyState.style.display = 'block';
      this.el.tokenList.appendChild(this.el.emptyState);
      return;
    }
    this.el.emptyState.style.display = 'none';
    for (let token of this.tokens) {
      const item = document.createElement('div');
      item.className = 'token-item';
      item.dataset.token = token;
      item.innerHTML = `<span>@${this.usernames.get(token) || '読み込み中...'}</span><button data-action="remove">削除</button>`;
      this.el.tokenList.appendChild(item);
    }
  }

  removeToken(token) {
    this.tokens.delete(token);
    this.usernames.delete(token);
    this.clients.get(token)?.disconnect();
    this.clients.delete(token);
    this.renderTokenList();
    this.log(`@削除: ${token.slice(0,12)}...`, 'info');
  }

  async start() {
    if (this.isRunning) return;
    const guildId = this.el.guildId.value.trim();
    const channelId = this.el.channelId.value.trim();
    if (!guildId || !channelId) return this.log('サーバーIDまたはチャンネルIDが未入力です', 'error');
    if (this.tokens.size === 0) return this.log('トークンがありません', 'error');

    this.isRunning = true;
    this.el.joinBtn.disabled = true;
    this.el.joinBtn.textContent = '参加中...';
    this.el.progress.style.width = '0%';

    const settings = this.getSettings();
    let success = 0;

    for (const [i, token] of Array.from(this.tokens).entries()) {
      try {
        const client = new VCJoiner(token, guildId, channelId);
        await client.connect();
        this.clients.set(token, client);
        success++;
        this.log(`参加成功: @${this.usernames.get(token)}`, 'success');
      } catch (err) {
        this.log(`参加失敗: @${this.usernames.get(token) || token.slice(0,12)}...`, 'error');
      }
      this.updateProgress(i + 1, this.tokens.size);
      await randomDelay();
    }

    this.isRunning = false;
    this.el.joinBtn.disabled = false;
    this.el.joinBtn.textContent = 'VCに参加';
    this.log(`参加完了: ${success}/${this.tokens.size} アカウント`, success === this.tokens.size ? 'success' : 'error');
  }

  stop() {
    const guildId = this.el.guildId.value.trim();
    const channelId = this.el.channelId.value.trim();
    if (!guildId || !channelId) {
      this.log('サーバーIDまたはチャンネルIDが未入力です', 'error');
      return;
    }

    this.clients.forEach(c => c.disconnect());
    this.clients.clear();
    this.log(`全員退出しました (${this.tokens.size}アカウント)`, 'success');
  }

  updateAllClients() {
    if (this.clients.size === 0) {
      this.log('参加中のアカウントがいません', 'info');
      return;
    }

    const settings = this.getSettings();
    let success = 0;
    let failed = 0;

    this.clients.forEach((client, token) => {
      try {
        client.updateSettings(settings);
        success++;
      } catch {
        failed++;
      }
    });

    const action = settings.camera ? 'カメラ' : settings.mic ? 'マイク' : settings.deafen ? '無音' : settings.stream ? '配信' : '設定';
    this.log(`${action}更新: ${success}成功${failed > 0 ? `, ${failed}失敗` : ''}`, failed > 0 ? 'error' : 'success');
  }

  bindEvents() {
    this.el.addBtn.onclick = () => this.addTokensFromText(this.el.tokenInput.value);
    this.el.tokenInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.addTokensFromText(this.el.tokenInput.value);
      }
    });

    this.el.uploadBtn.onclick = () => this.el.fileInput.click();
    this.el.fileInput.onchange = e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async ev => await this.addTokensFromText(ev.target.result);
      reader.readAsText(file);
    };

    this.el.joinBtn.onclick = () => this.start();
    this.el.leaveBtn.onclick = () => this.stop();

    this.el.tokenList.onclick = e => {
      if (e.target.matches('[data-action="remove"]')) {
        const token = e.target.closest('.token-item').dataset.token;
        this.removeToken(token);
      }
    };

    ['cam', 'mic', 'deafen', 'stream'].forEach(id => {
      this.el[id].onchange = () => this.updateAllClients();
    });
  }

  updateProgress(current, total) {
    const percent = Math.round((current / total) * 100);
    this.el.progress.style.width = `${percent}%`;
  }
}

const app = new App();
