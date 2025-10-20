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
const SONIOX_MODEL = 'stt-rt-preview-v2';
const LANGUAGE = 'ro'; // Romanian

class SonioxTranscriptionService extends EventEmitter {
  constructor(channel) {
    super();
    this.channel = channel;
    this.ws = null;
    this.messageQueue = [];
    this.ready = false;
    this.finalTranscript = ''; // Committed finals
    this.partialTranscript = ''; // Current partial hypothesis
    this.lastSentPartial = ''; // For incremental partial sends
    this.debounceTimer = null;
    this.debounceDelay = 3000;
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
        let hasFinal = false;
        let newFinalText = '';

        // Process all tokens in the batch
        for (const token of message.tokens) {
          if (token.is_final) {
            // Append to finals with smart spacing
            if (token.text.match(/^[.,?!:;]/)) {
              // Punctuation: append directly
              newFinalText += token.text;
            } else {
              // Normal: add space if needed
              if (newFinalText && !newFinalText.endsWith(' ')) {
                newFinalText += ' ';
              }
              newFinalText += token.text;
            }
            hasFinal = true;
          } else {
            // Overwrite partial hypothesis (Soniox partials replace the current unfinalized segment)
            this.partialTranscript += (this.partialTranscript ? ' ' : '') + token.text; // Build partial
          }
        }

        if (hasFinal) {
          // Commit new finals, normalize, and send incremental (new finals + current partial)
          this.finalTranscript += (this.finalTranscript ? ' ' : '') + newFinalText;
          let toSend = newFinalText + (this.partialTranscript ? ' ' + this.partialTranscript : '');
          toSend = toSend.replace(/\s+/g, ' ').trim(); // Normalize whitespace
          this.emit('transcription', toSend, this.channel);
          // Reset partial after final (as finals commit the segment)
          this.partialTranscript = '';
          this.lastSentPartial = '';
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
        } else if (this.partialTranscript) {
          // Debounce partials: Send only incremental added text
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => {
            const normalizedPartial = this.partialTranscript.replace(/\s+/g, ' ').trim();
            const added = normalizedPartial.substring(this.lastSentPartial.length).trim();
            if (added) {
              this.emit('transcription', added, this.channel);
              this.lastSentPartial = normalizedPartial;
            }
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
