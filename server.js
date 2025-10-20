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
const SONIOX_MODEL = 'stt-rt-preview-v2'; // Updated to v2 for better performance (from Soniox examples)
const LANGUAGE = 'en'; // Change if needed

class SonioxTranscriptionService extends EventEmitter {
  constructor(channel) {
    super();
    this.channel = channel; // 'customer' or 'assistant'
    this.ws = null;
    this.messageQueue = []; // Buffer for audio data
    this.ready = false;
    this.transcriptBuffer = '';
    this.debounceTimer = null;
    this.debounceDelay = 3000; // 3 seconds
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return; // Avoid multiple connects
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
        // Add more options if needed
      };
      this.ws.send(JSON.stringify(config));
      this.ready = true;

      // Process queued audio
      while (this.messageQueue.length > 0) {
        this.send(this.messageQueue.shift());
      }
    });

    this.ws.on('message', (data) => {
      const message = JSON.parse(data);
      if (message.tokens) {
        const newText = message.tokens
          .filter(token => token.text)
          .map(token => token.text)
          .join(' ');
        if (newText) {
          this.transcriptBuffer += (this.transcriptBuffer ? ' ' : '') + newText;
        }
        if (message.tokens.some(token => token.is_final)) {
          this.emitTranscription();
        } else {
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => this.emitTranscription(), this.debounceDelay);
        }
      }
      if (message.finished) {
        this.ws.close();
      }
      if (message.error_code) {
        console.error(`Soniox error for ${this.channel}: ${message.error_message}`);
        this.ws.close();
      }
    });

    this.ws.on('close', () => {
      console.log(`Soniox WS closed for ${this.channel}`);
      this.ready = false;
      // Attempt reconnect if queue has data
      if (this.messageQueue.length > 0) {
        setTimeout(() => this.connect(), 1000);
      }
    });

    this.ws.on('error', (err) => {
      console.error(`Soniox WS error for ${this.channel}: ${err}`);
      this.ready = false;
      // Reconnect after delay
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

  emitTranscription() {
    if (this.transcriptBuffer) {
      this.emit('transcription', this.transcriptBuffer, this.channel);
      this.transcriptBuffer = '';
    }
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
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
      // Deinterleave stereo audio (linear16, interleaved: channel0, channel1)
      const customerAudio = Buffer.alloc(message.length / 2);
      const assistantAudio = Buffer.alloc(message.length / 2);
      for (let i = 0; i < message.length / 4; i++) {
        message.copy(customerAudio, i * 2, i * 4); // Bytes 0-1: channel 0 (customer)
        message.copy(assistantAudio, i * 2, i * 4 + 2); // Bytes 2-3: channel 1 (assistant)
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
