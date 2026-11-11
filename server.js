import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();

app.use(express.static(join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.type('text').send('ok\n');
});

// Serve SBMuFL data
app.get('/api/glyphs', (req, res) => {
  res.sendFile(join(__dirname, 'data/sbmufl/glyphnames.json'));
});

app.get('/api/ranges', (req, res) => {
  res.sendFile(join(__dirname, 'data/sbmufl/ranges.json'));
});

app.get('/api/classes', (req, res) => {
  res.sendFile(join(__dirname, 'data/sbmufl/classes.json'));
});

// Theory data
app.get('/api/theory/:file', (req, res) => {
  const allowed = ['neume-values', 'scales', 'fthora-rules', 'mode-keys', 'neume-combinations', 'martyria-rules', 'attractions'];
  const file = req.params.file.replace(/\.json$/, '');
  if (!allowed.includes(file)) return res.status(404).json({ error: 'not found' });
  res.sendFile(join(__dirname, `data/theory/${file}.json`));
});

// Accounts need Cloudflare Access and D1, so they exist only on the Worker
// (worker.js, lib/documents.js). Here the page sees "not set up" and hides
// Sign in; the editor works as a visitor.
app.all('/api/account/*', (req, res) => {
  res.status(503).json({ error: 'Sign-in is not set up', configured: false });
});
app.get('/login', (req, res) => res.redirect('/'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${new Date().toISOString()}] Gorgon listening on 0.0.0.0:${PORT}`);
});
