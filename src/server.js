const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { authenticate, requireRole } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const recommendationsRoutes = require('./routes/recommendations');
const approvalsRoutes = require('./routes/approvals');
const forecastsRoutes = require('./routes/forecasts');
const configRoutes = require('./routes/config');
const onboardingRoutes = require('./routes/onboarding');
const adminRoutes = require('./routes/admin');
const reportsRoutes = require('./routes/reports');
const agentsRoutes = require('./routes/agents');
const snapshotsRoutes = require('./routes/snapshots');
const pipelineRoutes = require('./routes/pipeline');
const calendarRoutes = require('./routes/calendar');
const tokenService = require('./services/tokenService');

const app = express();

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim()),
  credentials: true,
}));
app.use(morgan('combined'));
app.use(express.json());

// Health check
app.get('/api/v1/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth routes (login is public, change-password has internal auth)
app.use('/api/v1/auth', authRoutes);

// Protected routes
app.use('/api/v1/dashboard', authenticate, dashboardRoutes);
app.use('/api/v1/recommendations', authenticate, recommendationsRoutes);
app.use('/api/v1/approvals', authenticate, approvalsRoutes);
app.use('/api/v1/forecasts', authenticate, forecastsRoutes);
app.use('/api/v1/config', authenticate, configRoutes);
app.use('/api/v1/onboarding', authenticate, requireRole('super_admin', 'hotel_admin'), onboardingRoutes);
app.use('/api/v1/admin', authenticate, requireRole('super_admin'), adminRoutes);
app.use('/api/v1/reports', authenticate, reportsRoutes);

// Agent internal API (Agent-Key auth, not JWT)
app.use('/api/v1/agents', agentsRoutes);
app.use('/api/v1/snapshots', snapshotsRoutes);

// M2 Data Pipeline API
app.use('/api/v1/pipeline', authenticate, pipelineRoutes);

// Calendar API
app.use('/api/v1/calendar', authenticate, calendarRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', message: '接口不存在' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
});

const PORT = parseInt(process.env.API_PORT || '3002');
const HOST = process.env.API_HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`HotelAI API server running on http://${HOST}:${PORT}`);
  // Start M2 data pipeline scheduler
  tokenService.start();
});

module.exports = app;
