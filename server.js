const express = require('express');
const cors = require('cors');
const { router: devicesRouter } = require('./routes/devices');
const uploadsRouter = require('./routes/uploads');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/devices', devicesRouter);
app.use('/uploads', uploadsRouter);

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Fleet backup API running on port ${PORT}`));
