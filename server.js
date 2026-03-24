const express = require('express');
const bodyParser = require('body-parser');
const webhook = require('./api/webhook');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.post('/api/webhook', webhook);

app.listen(port, () => {
  console.log(`WhatsApp Assistant server running at http://localhost:${port}`);
  console.log(`Webhook endpoint: http://localhost:${port}/api/webhook`);
});
