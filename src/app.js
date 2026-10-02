import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import 'dotenv/config';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import patientRoutes from './routes/patients.js';
import billingItemRoutes from './routes/billingItems.js';
import visitRoutes from './routes/visits.js';
import dashboardRoutes from './routes/dashboard.js';
import hospitalRoutes from './routes/hospital.js';
import accountRoutes from './routes/account.js';
import reportRoutes from './routes/reports.js';
import superAdminRoutes from './routes/superAdmin.js';
import { auth } from './middleware/auth.js';

const app = express();
app.use(helmet());
const configuredOrigins = new Set(
  String(process.env.FRONTEND_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
);
const isPrivateNetworkOrigin = (origin) => {
  if (process.env.NODE_ENV === 'production') return false;
  try {
    const url = new URL(origin);
    const host = url.hostname;
    const privateHost = host === 'localhost' || host === '127.0.0.1' || host === '::1'
      || /^10\./.test(host)
      || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    return ['http:', 'https:'].includes(url.protocol) && privateHost && url.port === '5173';
  } catch {
    return false;
  }
};
app.use(cors({
  origin(origin, callback) {
    if (!origin || configuredOrigins.has(origin) || isPrivateNetworkOrigin(origin)) return callback(null, true);
    return callback(new Error('Frontend origin is not allowed'));
  },
}));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/users', auth, userRoutes);
app.use('/api/patients', auth, patientRoutes);
app.use('/api/billing-items', auth, billingItemRoutes);
app.use('/api/visits', auth, visitRoutes);
app.use('/api/dashboard', auth, dashboardRoutes);
app.use('/api/hospital', auth, hospitalRoutes);
app.use('/api/account', auth, accountRoutes);
app.use('/api/reports', auth, reportRoutes);
app.use('/api/super-admin', auth, superAdminRoutes);

app.use((err, _req, res, _next) => {
  if (err?.name === 'ZodError') return res.status(400).json({ message: 'Invalid input', details: err.issues });
  if (err?.code === '23505') return res.status(409).json({ message: 'This record already exists' });
  console.error(err);
  res.status(err.status || 500).json({ message: err.message || 'Internal server error' });
});

export default app;
