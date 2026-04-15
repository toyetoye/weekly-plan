require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const SQL = `
-- Weekly Plan schema
CREATE SCHEMA IF NOT EXISTS weekly_plan;

-- ─── Users ───
CREATE TABLE IF NOT EXISTS weekly_plan.users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(80) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin','superintendent','vessel','manager')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Vessels ───
CREATE TABLE IF NOT EXISTS weekly_plan.vessels (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  vessel_type VARCHAR(40),
  imo VARCHAR(20),
  active BOOLEAN DEFAULT TRUE
);

-- ─── User-vessel assignments ───
CREATE TABLE IF NOT EXISTS weekly_plan.user_vessels (
  user_id INT REFERENCES weekly_plan.users(id) ON DELETE CASCADE,
  vessel_id INT REFERENCES weekly_plan.vessels(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, vessel_id)
);

-- ─── Crew ───
CREATE TABLE IF NOT EXISTS weekly_plan.crew (
  id SERIAL PRIMARY KEY,
  vessel_id INT REFERENCES weekly_plan.vessels(id) ON DELETE CASCADE,
  rank VARCHAR(60) NOT NULL,
  name VARCHAR(120) NOT NULL,
  joined DATE,
  department VARCHAR(20) CHECK (department IN ('deck','engine')),
  contract_months INT DEFAULT 4,
  active BOOLEAN DEFAULT TRUE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Meetings (one per vessel per week) ───
CREATE TABLE IF NOT EXISTS weekly_plan.meetings (
  id SERIAL PRIMARY KEY,
  vessel_id INT REFERENCES weekly_plan.vessels(id) ON DELETE CASCADE,
  week_number INT NOT NULL,
  year INT NOT NULL,
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft','vessel_prep','in_progress','completed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  closed_by INT REFERENCES weekly_plan.users(id),
  UNIQUE(vessel_id, week_number, year)
);

-- ─── Voyage info per meeting ───
CREATE TABLE IF NOT EXISTS weekly_plan.voyage_info (
  id SERIAL PRIMARY KEY,
  meeting_id INT REFERENCES weekly_plan.meetings(id) ON DELETE CASCADE UNIQUE,
  load_port VARCHAR(120),
  discharge_port VARCHAR(120),
  eta_load VARCHAR(60),
  eta_discharge VARCHAR(60),
  opl_location VARCHAR(120),
  opl_date VARCHAR(60),
  tech_onboard VARCHAR(120)
);

-- ─── Agenda template (configurable per vessel type) ───
CREATE TABLE IF NOT EXISTS weekly_plan.agenda_templates (
  id SERIAL PRIMARY KEY,
  vessel_type VARCHAR(40),
  item_number INT NOT NULL,
  title VARCHAR(200) NOT NULL,
  focus TEXT,
  active BOOLEAN DEFAULT TRUE
);

-- ─── Agenda remarks (per meeting per agenda item) ───
CREATE TABLE IF NOT EXISTS weekly_plan.agenda_remarks (
  id SERIAL PRIMARY KEY,
  meeting_id INT REFERENCES weekly_plan.meetings(id) ON DELETE CASCADE,
  agenda_item_id INT REFERENCES weekly_plan.agenda_templates(id),
  vessel_remark TEXT DEFAULT '',
  shore_comment TEXT DEFAULT '',
  new_actions TEXT DEFAULT '',
  vessel_updated_at TIMESTAMPTZ,
  vessel_updated_by INT REFERENCES weekly_plan.users(id),
  shore_updated_at TIMESTAMPTZ,
  shore_updated_by INT REFERENCES weekly_plan.users(id),
  UNIQUE(meeting_id, agenda_item_id)
);

-- ─── Action items (persistent per vessel, not per meeting) ───
CREATE TABLE IF NOT EXISTS weekly_plan.action_items (
  id SERIAL PRIMARY KEY,
  vessel_id INT REFERENCES weekly_plan.vessels(id) ON DELETE CASCADE,
  category VARCHAR(10) NOT NULL,
  equipment VARCHAR(200) NOT NULL,
  condition VARCHAR(60) DEFAULT 'Satisfactory',
  action_plan TEXT DEFAULT '',
  date_reported DATE,
  status VARCHAR(20) DEFAULT 'OPEN' CHECK (status IN ('OPEN','ONGOING','IN HAND','CLOSED')),
  supt_comment TEXT DEFAULT '',
  date_resolved DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Action item history (audit trail) ───
CREATE TABLE IF NOT EXISTS weekly_plan.action_item_history (
  id SERIAL PRIMARY KEY,
  action_item_id INT REFERENCES weekly_plan.action_items(id) ON DELETE CASCADE,
  field_changed VARCHAR(60),
  old_value TEXT,
  new_value TEXT,
  changed_by INT REFERENCES weekly_plan.users(id),
  changed_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Agenda remarks history (snapshot on meeting close) ───
CREATE TABLE IF NOT EXISTS weekly_plan.agenda_remarks_history (
  id SERIAL PRIMARY KEY,
  meeting_id INT REFERENCES weekly_plan.meetings(id) ON DELETE CASCADE,
  agenda_item_id INT REFERENCES weekly_plan.agenda_templates(id),
  vessel_remark TEXT,
  shore_comment TEXT,
  new_actions TEXT,
  snapshot_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Supporting data registers ───
CREATE TABLE IF NOT EXISTS weekly_plan.supporting_data (
  id SERIAL PRIMARY KEY,
  vessel_id INT REFERENCES weekly_plan.vessels(id) ON DELETE CASCADE,
  category VARCHAR(60) NOT NULL,
  title VARCHAR(200),
  content TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by INT REFERENCES weekly_plan.users(id)
);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(SQL);
    console.log('Schema created successfully');
  } catch (err) {
    console.error('Migration error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { migrate, pool };

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(() => process.exit(1));
}
