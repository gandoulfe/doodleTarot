const express = require('express');
const path = require('path');
const { createClient } = require('@libsql/client');
const { nanoid } = require('nanoid');

const db = createClient(
  process.env.TURSO_DATABASE_URL
    ? { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }
    : { url: `file:${path.join(__dirname, 'data.db')}` }
);

const initDone = db.batch([
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS event_dates (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS participants (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    name TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS votes (
    participant_id TEXT NOT NULL,
    date_id TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (participant_id, date_id)
  )`
]);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(async (req, res, next) => {
  await initDone;
  next();
});

app.post('/api/events', async (req, res) => {
  const { name, description, dates } = req.body;
  if (!name || !Array.isArray(dates) || dates.length === 0) {
    return res.status(400).json({ error: 'name et dates requis' });
  }
  const id = nanoid(10);
  const statements = [
    { sql: 'INSERT INTO events (id, name, description) VALUES (?, ?, ?)', args: [id, name, description || ''] },
    ...dates.map((label, i) => ({
      sql: 'INSERT INTO event_dates (id, event_id, label, sort_order) VALUES (?, ?, ?, ?)',
      args: [nanoid(8), id, label, i]
    }))
  ];
  await db.batch(statements);
  res.json({ id });
});

app.get('/api/events', async (req, res) => {
  const eventsRes = await db.execute(
    `SELECT e.id, e.name, e.created_at, COUNT(DISTINCT d.id) as date_count, COUNT(DISTINCT p.id) as participant_count
     FROM events e
     LEFT JOIN event_dates d ON d.event_id = e.id
     LEFT JOIN participants p ON p.event_id = e.id
     GROUP BY e.id
     ORDER BY e.created_at DESC`
  );
  res.json(eventsRes.rows);
});

async function getEventData(id) {
  const eventRes = await db.execute({ sql: 'SELECT * FROM events WHERE id = ?', args: [id] });
  const event = eventRes.rows[0];
  if (!event) return null;
  const datesRes = await db.execute({ sql: 'SELECT id, label FROM event_dates WHERE event_id = ? ORDER BY sort_order', args: [id] });
  const participantsRes = await db.execute({ sql: 'SELECT id, name FROM participants WHERE event_id = ?', args: [id] });
  const votesRes = await db.execute({
    sql: `SELECT v.participant_id, v.date_id, v.status FROM votes v
          JOIN participants p ON p.id = v.participant_id
          WHERE p.event_id = ?`,
    args: [id]
  });
  return {
    event,
    dates: datesRes.rows,
    participants: participantsRes.rows,
    votes: votesRes.rows
  };
}

app.get('/api/events/:id', async (req, res) => {
  const data = await getEventData(req.params.id);
  if (!data) return res.status(404).json({ error: 'introuvable' });
  res.json(data);
});

app.post('/api/events/:id/vote', async (req, res) => {
  const eventId = req.params.id;
  const eventRes = await db.execute({ sql: 'SELECT id FROM events WHERE id = ?', args: [eventId] });
  if (!eventRes.rows[0]) return res.status(404).json({ error: 'introuvable' });

  const { name, votes } = req.body;
  if (!name || typeof name !== 'string' || !name.trim() || !votes) {
    return res.status(400).json({ error: 'nom et votes requis' });
  }
  const cleanName = name.trim();

  const existing = await db.execute({
    sql: 'SELECT id FROM participants WHERE event_id = ? AND LOWER(name) = LOWER(?)',
    args: [eventId, cleanName]
  });

  let participantId;
  if (existing.rows[0]) {
    participantId = existing.rows[0].id;
  } else {
    participantId = nanoid(10);
    await db.execute({
      sql: 'INSERT INTO participants (id, event_id, name) VALUES (?, ?, ?)',
      args: [participantId, eventId, cleanName]
    });
  }

  const upsertStatements = Object.entries(votes).map(([dateId, status]) => ({
    sql: `INSERT INTO votes (participant_id, date_id, status) VALUES (?, ?, ?)
          ON CONFLICT(participant_id, date_id) DO UPDATE SET status = excluded.status`,
    args: [participantId, dateId, status]
  }));
  if (upsertStatements.length) await db.batch(upsertStatements);

  res.json(await getEventData(eventId));
});

app.delete('/api/events/:id/participants/:participantId', async (req, res) => {
  const { id, participantId } = req.params;
  await db.batch([
    { sql: 'DELETE FROM votes WHERE participant_id = ?', args: [participantId] },
    { sql: 'DELETE FROM participants WHERE id = ? AND event_id = ?', args: [participantId, id] }
  ]);
  res.json(await getEventData(id));
});

app.delete('/api/events/:id', async (req, res) => {
  const { id } = req.params;
  await db.batch([
    { sql: 'DELETE FROM votes WHERE participant_id IN (SELECT id FROM participants WHERE event_id = ?)', args: [id] },
    { sql: 'DELETE FROM participants WHERE event_id = ?', args: [id] },
    { sql: 'DELETE FROM event_dates WHERE event_id = ?', args: [id] },
    { sql: 'DELETE FROM events WHERE id = ?', args: [id] }
  ]);
  res.json({ ok: true });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Table de tarot ouverte sur http://localhost:${PORT}`));
}

module.exports = app;
