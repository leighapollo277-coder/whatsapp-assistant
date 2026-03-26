const express = require('express');
const app = express();
const path = require('path');

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Minimal health check to verify Express is alive
app.get('/api/health', (req, res) => res.status(200).send('Vercel Monolith is ALIVE'));

// Test if loading webhook causes crash
app.all('/api/webhook', async (req, res) => {
  try {
    const webhook = require('./api/webhook');
    return await webhook(req, res);
  } catch (err) {
    console.error('Webhook Load Error:', err.message);
    res.status(500).send('Webhook failed to load: ' + err.message);
  }
});

app.use(express.static('public'));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

module.exports = app;
