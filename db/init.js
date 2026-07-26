const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'hotelai',
  password: process.env.DB_PASSWORD || 'hotelai_dev_2026',
  database: process.env.DB_NAME || 'hotelai_dev',
});

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
});

async function initDb() {
  const schemaPath = path.resolve(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  const client = await pool.connect();
  try {
    await client.query(schema);
    console.log('Database schema initialized successfully.');
  } catch (err) {
    console.error('Error initializing database:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb };
