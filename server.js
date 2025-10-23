require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const EventEmitter = require('events');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3001;
const SONIOX_API_KEY = process.env.SONIOX_API_KEY;
const SONIOX_WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
const SONIOX_MODEL = 'stt-rt-v3';
const LANGUAGE = 'ro'; // Romanian

class SonioxTranscriptionService extends EventEmitter {
  constructor(channel) {
    super();
    this.channel = channel;
    this.ws = null;
    this.messageQueue = [];
    this.ready = false;
    this.finalTranscript = '';
    this.partialTranscript = '';
    this.lastSentTranscript = '';
    this.debounceTimer = null;
    this.debounceDelay = 3000;
  }

  buildText(tokens) {
    // Direct concatenation without added spaces; normalize whitespace after
    return tokens.map(token => token.text).join('').replace(/\s+/g, ' ').trim();
  }

  getFullCurrent() {
    let full = this.finalTranscript;
    if (this.partialTranscript) {
      full += this.partialTranscript; // No space, as partial may continue the word
    }
    return full.replace(/\s+/g, ' ').trim();
  }

  emitDelta() {
    const fullCurrent = this.getFullCurrent();
    const added = fullCurrent.substring(this.lastSentTranscript.length).trim();
    if (added) {
      this.emit('transcription', added, this.channel);
      this.lastSentTranscript = fullCurrent;
    }
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.ws = new WebSocket(SONIOX_WS_URL);

    this.ws.on('open', () => {
      console.log(`Soniox WS opened for ${this.channel}`);
      const config = {
        api_key: SONIOX_API_KEY,
        model: SONIOX_MODEL,
        audio_format: 'pcm_s16le',
        sample_rate: 16000,
        num_channels: 1,
        language_hints: [LANGUAGE]
      };
      this.ws.send(JSON.stringify(config));
      this.ready = true;
      while (this.messageQueue.length > 0) {
        this.send(this.messageQueue.shift());
      }
    });

    this.ws.on('message', (data) => {
      const message = JSON.parse(data);
      if (message.error_code) {
        console.error(`Soniox error for ${this.channel}: ${message.error_message}`);
        this.ws.close();
        return;
      }
      if (message.finished) {
        this.ws.close();
        return;
      }
      if (message.tokens) {
        const finalTokens = message.tokens.filter(token => token.is_final);
        const partialTokens = message.tokens.filter(token => !token.is_final);

        const newFinalText = this.buildText(finalTokens);
        const newPartialText = this.buildText(partialTokens);

        let hasFinal = finalTokens.length > 0;

        if (hasFinal) {
          this.finalTranscript += newFinalText; // Append directly
          this.partialTranscript = newPartialText;
          this.emitDelta();
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
        } else if (partialTokens.length > 0) {
          this.partialTranscript = newPartialText; // Replace
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => {
            this.emitDelta();
          }, this.debounceDelay);
        }
      }
    });

    this.ws.on('close', () => {
      console.log(`Soniox WS closed for ${this.channel}`);
      this.ready = false;
      if (this.messageQueue.length > 0) {
        setTimeout(() => this.connect(), 1000);
      }
    });

    this.ws.on('error', (err) => {
      console.error(`Soniox WS error for ${this.channel}: ${err}`);
      this.ready = false;
      setTimeout(() => this.connect(), 1000);
    });
  }

  send(data) {
    if (this.ready && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      this.messageQueue.push(data);
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        this.connect();
      }
    }
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

wss.on('connection', (ws) => {
  console.log('Vapi WS connected');
  let customerService = new SonioxTranscriptionService('customer');
  let assistantService = new SonioxTranscriptionService('assistant');
  customerService.connect();
  assistantService.connect();

  ws.on('message', (message) => {
    if (typeof message === 'string') {
      try {
        const data = JSON.parse(message);
        if (data.type === 'start') {
          console.log('Start message received:', data);
        }
      } catch (err) {
        console.error('JSON parse error:', err);
      }
    } else if (Buffer.isBuffer(message)) {
      const customerAudio = Buffer.alloc(message.length / 2);
      const assistantAudio = Buffer.alloc(message.length / 2);
      for (let i = 0; i < message.length / 4; i++) {
        message.copy(customerAudio, i * 2, i * 4);
        message.copy(assistantAudio, i * 2, i * 4 + 2);
      }
      customerService.send(customerAudio);
      assistantService.send(assistantAudio);
    }
  });

  const sendTranscript = (transcript, channel) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'transcriber-response',
        transcription: transcript,
        channel: channel
      }));
    }
  };

  customerService.on('transcription', sendTranscript);
  assistantService.on('transcription', sendTranscript);

  ws.on('close', () => {
    console.log('Vapi WS closed');
    customerService.close();
    assistantService.close();
  });

  ws.on('error', (err) => console.error('Vapi WS error:', err));
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
