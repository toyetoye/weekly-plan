require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const { Pool } = require('pg');
const { migrate } = require('../db/migrate');

const app = express();
const PORT = process.env.PORT || 3900;
const JWT_SECRET = process.env.JWT_SECRET || 'forcap-weekly-plan-secret-2026';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Auth middleware ───
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
}

// ─── Auth routes ───
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const r = await pool.query('SELECT * FROM weekly_plan.users WHERE username = $1', [username]);
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = r.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role, display_name: user.display_name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role, display_name: user.display_name } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/me', auth, (req, res) => res.json(req.user));

// ─── Vessels ───
app.get('/api/vessels', auth, async (req, res) => {
  try {
    let q;
    if (req.user.role === 'admin' || req.user.role === 'manager') {
      q = await pool.query('SELECT * FROM weekly_plan.vessels WHERE active = true ORDER BY id');
    } else {
      q = await pool.query(`
        SELECT v.* FROM weekly_plan.vessels v
        JOIN weekly_plan.user_vessels uv ON v.id = uv.vessel_id
        WHERE uv.user_id = $1 AND v.active = true ORDER BY v.id
      `, [req.user.id]);
    }
    res.json(q.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Crew ───
app.get('/api/vessels/:vid/crew', auth, async (req, res) => {
  try {
    const q = await pool.query(
      'SELECT * FROM weekly_plan.crew WHERE vessel_id = $1 AND active = true ORDER BY department, id',
      [req.params.vid]
    );
    res.json(q.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/vessels/:vid/crew', auth, async (req, res) => {
  if (req.user.role === 'manager') return res.status(403).json({ error: 'Forbidden' });
  const { rank, name, joined, department, contract_months } = req.body;
  try {
    const q = await pool.query(
      `INSERT INTO weekly_plan.crew (vessel_id, rank, name, joined, department, contract_months) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.vid, rank, name, joined, department, contract_months || 4]
    );
    res.json(q.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/crew/:id', auth, async (req, res) => {
  if (req.user.role === 'manager') return res.status(403).json({ error: 'Forbidden' });
  const { rank, name, joined, department, contract_months } = req.body;
  try {
    const q = await pool.query(
      `UPDATE weekly_plan.crew SET rank=$1, name=$2, joined=$3, department=$4, contract_months=$5, updated_at=NOW() WHERE id=$6 RETURNING *`,
      [rank, name, joined, department, contract_months, req.params.id]
    );
    res.json(q.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/crew/:id', auth, async (req, res) => {
  if (req.user.role === 'manager') return res.status(403).json({ error: 'Forbidden' });
  try {
    await pool.query('UPDATE weekly_plan.crew SET active = false WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Meetings ───
app.get('/api/vessels/:vid/meetings', auth, async (req, res) => {
  try {
    const q = await pool.query(
      'SELECT * FROM weekly_plan.meetings WHERE vessel_id = $1 ORDER BY year DESC, week_number DESC',
      [req.params.vid]
    );
    res.json(q.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/vessels/:vid/meetings', auth, async (req, res) => {
  const { week_number, year } = req.body;
  try {
    const q = await pool.query(
      `INSERT INTO weekly_plan.meetings (vessel_id, week_number, year, status) VALUES ($1,$2,$3,'draft')
       ON CONFLICT (vessel_id, week_number, year) DO NOTHING RETURNING *`,
      [req.params.vid, week_number, year]
    );
    if (!q.rows.length) {
      const existing = await pool.query(
        'SELECT * FROM weekly_plan.meetings WHERE vessel_id=$1 AND week_number=$2 AND year=$3',
        [req.params.vid, week_number, year]
      );
      return res.json(existing.rows[0]);
    }
    // Create agenda remark slots
    const templates = await pool.query('SELECT id FROM weekly_plan.agenda_templates WHERE active = true ORDER BY item_number');
    for (const t of templates.rows) {
      await pool.query(
        `INSERT INTO weekly_plan.agenda_remarks (meeting_id, agenda_item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [q.rows[0].id, t.id]
      );
    }
    res.json(q.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/meetings/:id/status', auth, async (req, res) => {
  const { status } = req.body;
  try {
    const meeting = await pool.query('SELECT * FROM weekly_plan.meetings WHERE id = $1', [req.params.id]);
    if (!meeting.rows.length) return res.status(404).json({ error: 'Not found' });

    const current = meeting.rows[0].status;
    const flow = ['draft', 'vessel_prep', 'in_progress', 'completed'];
    const curIdx = flow.indexOf(current);
    const newIdx = flow.indexOf(status);

    // Reopen: only admin/supt
    if (status === 'in_progress' && current === 'completed') {
      if (req.user.role !== 'admin' && req.user.role !== 'superintendent') {
        return res.status(403).json({ error: 'Only admin/superintendent can reopen' });
      }
    } else if (newIdx !== curIdx + 1) {
      return res.status(400).json({ error: 'Invalid status transition' });
    }

    // On close: snapshot remarks, clear vessel remarks
    if (status === 'completed') {
      const remarks = await pool.query(
        'SELECT * FROM weekly_plan.agenda_remarks WHERE meeting_id = $1', [req.params.id]
      );
      for (const r of remarks.rows) {
        await pool.query(
          `INSERT INTO weekly_plan.agenda_remarks_history (meeting_id, agenda_item_id, vessel_remark, shore_comment, new_actions)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.params.id, r.agenda_item_id, r.vessel_remark, r.shore_comment, r.new_actions]
        );
        // Clear vessel remarks for next cycle
        await pool.query(
          'UPDATE weekly_plan.agenda_remarks SET vessel_remark = $1 WHERE id = $2', ['', r.id]
        );
      }
    }

    const extra = status === 'completed' ? ', closed_at = NOW(), closed_by = $3' : '';
    const params = status === 'completed'
      ? [status, req.params.id, req.user.id]
      : [status, req.params.id];

    await pool.query(
      `UPDATE weekly_plan.meetings SET status = $1${extra} WHERE id = $2`,
      params
    );

    const updated = await pool.query('SELECT * FROM weekly_plan.meetings WHERE id = $1', [req.params.id]);
    res.json(updated.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Agenda ───
app.get('/api/agenda-templates', auth, async (req, res) => {
  try {
    const q = await pool.query('SELECT * FROM weekly_plan.agenda_templates WHERE active = true ORDER BY item_number');
    res.json(q.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/agenda-templates', auth, async (req, res) => {
  if (req.user.role === 'manager') return res.status(403).json({ error: 'Forbidden' });
  const { item_number, title, focus } = req.body;
  try {
    const q = await pool.query(
      `INSERT INTO weekly_plan.agenda_templates (vessel_type, item_number, title, focus) VALUES ('ALL',$1,$2,$3) RETURNING *`,
      [item_number, title, focus || '']
    );
    res.json(q.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/agenda-templates/:id', auth, async (req, res) => {
  if (req.user.role === 'manager') return res.status(403).json({ error: 'Forbidden' });
  const { title, focus, item_number } = req.body;
  try {
    const q = await pool.query(
      `UPDATE weekly_plan.agenda_templates SET title=COALESCE($1,title), focus=COALESCE($2,focus), item_number=COALESCE($3,item_number) WHERE id=$4 RETURNING *`,
      [title, focus, item_number, req.params.id]
    );
    res.json(q.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/agenda-templates/:id', auth, async (req, res) => {
  if (req.user.role === 'manager') return res.status(403).json({ error: 'Forbidden' });
  try {
    await pool.query('UPDATE weekly_plan.agenda_templates SET active = false WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/meetings/:mid/remarks', auth, async (req, res) => {
  try {
    const q = await pool.query(`
      SELECT ar.*, at.item_number, at.title, at.focus
      FROM weekly_plan.agenda_remarks ar
      JOIN weekly_plan.agenda_templates at ON ar.agenda_item_id = at.id
      WHERE ar.meeting_id = $1
      ORDER BY at.item_number
    `, [req.params.mid]);
    res.json(q.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/remarks/:id', auth, async (req, res) => {
  const { vessel_remark, shore_comment, new_actions } = req.body;
  try {
    const sets = [];
    const vals = [];
    let i = 1;

    if (vessel_remark !== undefined) {
      sets.push(`vessel_remark = $${i}, vessel_updated_at = NOW(), vessel_updated_by = $${i+1}`);
      vals.push(vessel_remark, req.user.id);
      i += 2;
    }
    if (shore_comment !== undefined) {
      sets.push(`shore_comment = $${i}, shore_updated_at = NOW(), shore_updated_by = $${i+1}`);
      vals.push(shore_comment, req.user.id);
      i += 2;
    }
    if (new_actions !== undefined) {
      sets.push(`new_actions = $${i}`);
      vals.push(new_actions);
      i += 1;
    }

    vals.push(req.params.id);
    const q = await pool.query(
      `UPDATE weekly_plan.agenda_remarks SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    res.json(q.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Historical remarks
app.get('/api/meetings/:mid/remarks-history', auth, async (req, res) => {
  try {
    const q = await pool.query(`
      SELECT arh.*, at.item_number, at.title
      FROM weekly_plan.agenda_remarks_history arh
      JOIN weekly_plan.agenda_templates at ON arh.agenda_item_id = at.id
      WHERE arh.meeting_id = $1
      ORDER BY at.item_number
    `, [req.params.mid]);
    res.json(q.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Action Items ───
app.get('/api/vessels/:vid/actions', auth, async (req, res) => {
  try {
    const q = await pool.query(
      'SELECT * FROM weekly_plan.action_items WHERE vessel_id = $1 ORDER BY category, id',
      [req.params.vid]
    );
    res.json(q.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/vessels/:vid/actions', auth, async (req, res) => {
  if (req.user.role === 'manager') return res.status(403).json({ error: 'Forbidden' });
  const { category, equipment, condition, action_plan, date_reported, status, supt_comment } = req.body;
  try {
    const q = await pool.query(
      `INSERT INTO weekly_plan.action_items (vessel_id, category, equipment, condition, action_plan, date_reported, status, supt_comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.vid, category, equipment, condition || 'Satisfactory', action_plan || '', date_reported || null, status || 'OPEN', supt_comment || '']
    );
    res.json(q.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/actions/:id', auth, async (req, res) => {
  if (req.user.role === 'manager') return res.status(403).json({ error: 'Forbidden' });
  const { category, equipment, condition, action_plan, status, supt_comment, date_reported, date_resolved } = req.body;
  try {
    // Log changes for audit
    const old = await pool.query('SELECT * FROM weekly_plan.action_items WHERE id = $1', [req.params.id]);
    if (old.rows.length) {
      const o = old.rows[0];
      const fields = { category, equipment, condition, action_plan, status, supt_comment };
      for (const [field, newVal] of Object.entries(fields)) {
        if (newVal !== undefined && newVal !== o[field === 'action_plan' ? 'action_plan' : field]) {
          await pool.query(
            `INSERT INTO weekly_plan.action_item_history (action_item_id, field_changed, old_value, new_value, changed_by)
             VALUES ($1,$2,$3,$4,$5)`,
            [req.params.id, field, String(o[field === 'action_plan' ? 'action_plan' : field] || ''), String(newVal), req.user.id]
          );
        }
      }
    }

    const q = await pool.query(
      `UPDATE weekly_plan.action_items SET
        category = COALESCE($1, category),
        equipment = COALESCE($2, equipment),
        condition = COALESCE($3, condition),
        action_plan = COALESCE($4, action_plan),
        status = COALESCE($5, status),
        supt_comment = COALESCE($6, supt_comment),
        date_reported = COALESCE($7, date_reported),
        date_resolved = $8,
        updated_at = NOW()
       WHERE id = $9 RETURNING *`,
      [category, equipment, condition, action_plan, status, supt_comment, date_reported, date_resolved || null, req.params.id]
    );
    res.json(q.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/actions/:id', auth, async (req, res) => {
  if (req.user.role === 'manager') return res.status(403).json({ error: 'Forbidden' });
  try {
    await pool.query('DELETE FROM weekly_plan.action_items WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Action history
app.get('/api/actions/:id/history', auth, async (req, res) => {
  try {
    const q = await pool.query(
      `SELECT h.*, u.display_name as changed_by_name
       FROM weekly_plan.action_item_history h
       LEFT JOIN weekly_plan.users u ON h.changed_by = u.id
       WHERE h.action_item_id = $1 ORDER BY h.changed_at DESC`,
      [req.params.id]
    );
    res.json(q.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Voyage info ───
app.get('/api/meetings/:mid/voyage', auth, async (req, res) => {
  try {
    const q = await pool.query('SELECT * FROM weekly_plan.voyage_info WHERE meeting_id = $1', [req.params.mid]);
    res.json(q.rows[0] || null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/meetings/:mid/voyage', auth, async (req, res) => {
  const { load_port, discharge_port, eta_load, eta_discharge, opl_location, opl_date, tech_onboard } = req.body;
  try {
    const q = await pool.query(`
      INSERT INTO weekly_plan.voyage_info (meeting_id, load_port, discharge_port, eta_load, eta_discharge, opl_location, opl_date, tech_onboard)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (meeting_id) DO UPDATE SET
        load_port=$2, discharge_port=$3, eta_load=$4, eta_discharge=$5, opl_location=$6, opl_date=$7, tech_onboard=$8
      RETURNING *
    `, [req.params.mid, load_port, discharge_port, eta_load, eta_discharge, opl_location, opl_date, tech_onboard]);
    res.json(q.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Supporting data ───
app.get('/api/vessels/:vid/supporting', auth, async (req, res) => {
  try {
    const q = await pool.query(
      'SELECT * FROM weekly_plan.supporting_data WHERE vessel_id = $1 ORDER BY category, id',
      [req.params.vid]
    );
    res.json(q.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Admin: user management ───
app.get('/api/admin/users', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  try {
    const q = await pool.query(`
      SELECT u.id, u.username, u.display_name, u.role, u.created_at,
        ARRAY_AGG(v.name) FILTER (WHERE v.name IS NOT NULL) as vessel_names
      FROM weekly_plan.users u
      LEFT JOIN weekly_plan.user_vessels uv ON u.id = uv.user_id
      LEFT JOIN weekly_plan.vessels v ON uv.vessel_id = v.id
      GROUP BY u.id ORDER BY u.id
    `);
    res.json(q.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Admin: create user ───
app.post('/api/admin/users', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { username, password, display_name, role, vessel_ids } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const q = await pool.query(
      `INSERT INTO weekly_plan.users (username, password_hash, display_name, role) VALUES ($1,$2,$3,$4) RETURNING id, username, display_name, role`,
      [username, hash, display_name, role]
    );
    const user = q.rows[0];
    if (vessel_ids && vessel_ids.length) {
      for (const vid of vessel_ids) {
        await pool.query('INSERT INTO weekly_plan.user_vessels (user_id, vessel_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [user.id, vid]);
      }
    }
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Admin: edit user ───
app.put('/api/admin/users/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { display_name, role, password, vessel_ids } = req.body;
  try {
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE weekly_plan.users SET display_name=$1, role=$2, password_hash=$3 WHERE id=$4', [display_name, role, hash, req.params.id]);
    } else {
      await pool.query('UPDATE weekly_plan.users SET display_name=$1, role=$2 WHERE id=$3', [display_name, role, req.params.id]);
    }
    if (vessel_ids !== undefined) {
      await pool.query('DELETE FROM weekly_plan.user_vessels WHERE user_id=$1', [req.params.id]);
      for (const vid of vessel_ids) {
        await pool.query('INSERT INTO weekly_plan.user_vessels (user_id, vessel_id) VALUES ($1,$2)', [req.params.id, vid]);
      }
    }
    const q = await pool.query(`
      SELECT u.id, u.username, u.display_name, u.role,
        ARRAY_AGG(v.id) FILTER (WHERE v.id IS NOT NULL) as vessel_ids,
        ARRAY_AGG(v.name) FILTER (WHERE v.name IS NOT NULL) as vessel_names
      FROM weekly_plan.users u
      LEFT JOIN weekly_plan.user_vessels uv ON u.id = uv.user_id
      LEFT JOIN weekly_plan.vessels v ON uv.vessel_id = v.id
      WHERE u.id = $1 GROUP BY u.id
    `, [req.params.id]);
    res.json(q.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Admin: delete user ───
app.delete('/api/admin/users/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  try {
    await pool.query('DELETE FROM weekly_plan.users WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Admin: vessel management ───
app.post('/api/admin/vessels', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { name, vessel_type, imo } = req.body;
  try {
    const q = await pool.query(
      'INSERT INTO weekly_plan.vessels (name, vessel_type, imo) VALUES ($1,$2,$3) RETURNING *',
      [name, vessel_type, imo]
    );
    res.json(q.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/vessels/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { name, vessel_type, imo } = req.body;
  try {
    const q = await pool.query(
      'UPDATE weekly_plan.vessels SET name=$1, vessel_type=$2, imo=$3 WHERE id=$4 RETURNING *',
      [name, vessel_type, imo, req.params.id]
    );
    res.json(q.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/vessels/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  try {
    await pool.query('UPDATE weekly_plan.vessels SET active = false WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SPA fallback
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
});

// ─── Start ───
async function start() {
  try {
    await migrate();
    console.log('DB migrated');
    // Check if seed needed
    const check = await pool.query('SELECT COUNT(*) FROM weekly_plan.users');
    if (parseInt(check.rows[0].count) === 0) {
      const { seed } = require('../db/seed');
      await seed();
      console.log('DB seeded');
    }
  } catch (err) {
    console.error('DB init error:', err.message);
  }
  app.listen(PORT, () => console.log(`FORCAP Weekly Plan running on port ${PORT}`));
}

start();
