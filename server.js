const express = require('express');
const bodyParser = require('body-parser');
const telegram = require('./api/telegram');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.post('/api/webhook', webhook);
app.post('/api/telegram', telegram);

app.listen(port, () => {
  console.log(`Assistant server running at http://localhost:${port}`);
  console.log(`WhatsApp Webhook endpoint: http://localhost:${port}/api/webhook`);
  console.log(`Telegram Webhook endpoint: http://localhost:${port}/api/telegram`);
});
