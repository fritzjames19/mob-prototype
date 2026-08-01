import express from 'express';
import cors from 'cors';
import 'dotenv/config';

import playerRoutes from './routes/players.js';
import questRoutes from './routes/quests.js';
import districtRoutes from './routes/districts.js';
import heatRoutes from './routes/heat.js';
import gangRoutes from './routes/gang.js';
import titleRoutes from './routes/titles.js';
import undergroundRoutes from './routes/underground.js';
import pvpRoutes from './routes/pvp.js';
import hitlistRoutes from './routes/hitlist.js';
import cardRoutes from './routes/cards.js';
import publicRoutes from './routes/public.js';

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: allowedOrigins.includes('*') ? true : allowedOrigins,
}));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.use(playerRoutes);
app.use(questRoutes);
app.use(districtRoutes);
app.use(heatRoutes);
app.use(gangRoutes);
app.use(titleRoutes);
app.use(undergroundRoutes);
app.use(pvpRoutes);
app.use(hitlistRoutes);
app.use(cardRoutes);
app.use(publicRoutes);

// Generic error handler as a last resort — anything that throws unexpectedly returns
// a clean 500 instead of leaking a stack trace to the client.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`MOB backend listening on :${port}`));
