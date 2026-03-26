const axios = require('axios');

class MessagingClient {
  async sendText(text) { throw new Error('Not implemented'); }
  async sendMedia(url, caption) { throw new Error('Not implemented'); }
  async sendVoice(url, caption) { throw new Error('Not implemented'); }
  async downloadMedia(mediaUrl) { throw new Error('Not implemented'); }
}

class TwilioMessagingClient extends MessagingClient {
  constructor(twilioClient, from, to) {
    super();
    this.client = twilioClient;
    this.from = from;
    this.to = to;
  }
  async sendText(text) {
    return await this.client.messages.create({ from: this.from, to: this.to, body: text });
  }
  async sendMedia(url, caption) {
    return await this.client.messages.create({ from: this.from, to: this.to, body: caption, mediaUrl: [url] });
  }
  async sendVoice(url, caption) {
    return await this.client.messages.create({ from: this.from, to: this.to, body: caption, mediaUrl: [url] });
  }
  async downloadMedia(mediaUrl) {
    const response = await axios({
      method: 'get', url: mediaUrl, responseType: 'arraybuffer',
      timeout: 15000,
      auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN }
    });
    return Buffer.from(response.data);
  }
}

class TelegramMessagingClient extends MessagingClient {
  constructor(token, chatId) {
    super();
    this.token = token;
    this.chatId = chatId;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }
  async sendText(text) {
    return await axios.post(`${this.baseUrl}/sendMessage`, { chat_id: this.chatId, text: text });
  }
  async sendMedia(url, caption) {
    return await axios.post(`${this.baseUrl}/sendPhoto`, { chat_id: this.chatId, photo: url, caption: caption });
  }
  async sendVoice(url, caption) {
    // Telegram's sendAudio is more flexible for MP3 than sendVoice which expects OGG
    return await axios.post(`${this.baseUrl}/sendAudio`, { chat_id: this.chatId, audio: url, caption: caption });
  }
  async downloadMedia(mediaUrl) {
    if (mediaUrl.startsWith('http')) {
      const response = await axios.get(mediaUrl, { responseType: 'arraybuffer', timeout: 15000 });
      return Buffer.from(response.data);
    }
    const fileResponse = await axios.get(`${this.baseUrl}/getFile?file_id=${mediaUrl}`, { timeout: 10000 });
    const filePath = fileResponse.data.result.file_path;
    const downloadResponse = await axios.get(`https://api.telegram.org/file/bot${this.token}/${filePath}`, { responseType: 'arraybuffer', timeout: 20000 });
    return Buffer.from(downloadResponse.data);
  }
}

module.exports = { TwilioMessagingClient, TelegramMessagingClient };
