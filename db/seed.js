require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const VESSELS = [
  ['LNG Port Harcourt 2','LNG DFDE','9238041'],
  ['LNG Rivers','LNG DFDE','9238039'],
  ['LNG Adamawa','LNG DFDE','9262388'],
  ['LNG Sokoto','LNG DFDE','9262376'],
  ['LNG Cross River','LNG DFDE','9291637'],
  ['LNG Lagos II','LNG DFDE','9262364'],
  ['LPG Alfred Temile','LPG FR','9859882'],
  ['LPG Alfred Temile 10','LPG FR','9894449'],
];

const AGENDA_ITEMS = [
  [1,'HSE','Safety performance, compliance, challenges and resolutions'],
  [2,'Budget performance review','Dashboard, budget phased targets, overspend, reasons and year end outlook'],
  [3,'Live condition report','Up to date status, discuss open actions and closeout changes'],
  [4,'LTMP','Discuss progress and key focus areas'],
  [5,'SIRE / certificates / class status','Class status, memos, condition of class, dispensation etc.'],
  [6,'Survey prep / hull scrubbing','MRs raised for survey, long lead items, refit schedule'],
  [7,'Wartsila online weekly digest','Latest bulletin and pending actions. Share screen'],
  [8,'Stern tube seal training','Last training date and schedule'],
  [9,'Mini performance trial','Last trial analysis, suggest improvement measures'],
  [10,'Monthly analysis (CM systems)','Yellowtec, Drew Marine, RLA, CBM, EoM feedback from OEMs'],
  [11,'Manning','SMT reliefs, handover progress, embarkation and disembarkation'],
  [12,'IT issues','Onboard IT systems, network, printers, software status'],
];

const THREE_MO_RANKS = ['Master','Chief Officer','Chief Engineer','2nd Engineer','Gas Engineer','ETO'];

const PH2_CREW = [
  ['Master','Capt Bala','2024-08-16','deck'],
  ['Chief Officer','Biezbardis, Kristaps','2024-11-13','deck'],
  ['2nd Officer','Roman','2024-05-30','deck'],
  ['3rd Officer','Kumar','2024-07-29','deck'],
  ['3rd Officer','Isa','2024-07-15','deck'],
  ['Chief Engineer','Jitender Singh','2024-09-17','engine'],
  ['2nd Engineer','Gladchenko, Anton','2024-11-13','engine'],
  ['Gas Engineer','Augustine Amalime','2024-09-17','engine'],
  ['3rd Engineer','Okebondu','2024-11-13','engine'],
  ['ETO','Kelechi Kalu','2024-08-16','engine'],
  ['4th Engineer','Daniel Sunday','2024-07-29','engine'],
  ['4th Engineer','Sochima Uche','2024-07-29','engine'],
];

const PH2_ACTIONS = [
  ['A','5x MGE','Satisfactory','MGE 2 OMD alarm. Spare delivered Port Louis.','2024-03-11','CLOSED'],
  ['A','MGE ancillary equipment','Satisfactory','MGE 3 DE bearing P/S defective. JCW preheater flow switches defective. OMD upgrade MGE1&3 done.','2024-04-04','OPEN'],
  ['A','Wartsila DMP 36K spares','Satisfactory','MGE1&2 completed. MGE 3,4,5 overdue for 36k.',null,'ONGOING'],
  ['A','Purifiers','Satisfactory','No.3 & No.5 MGE LO Purifier spares needed.',null,'OPEN'],
  ['A','2x Stern tubes','Satisfactory','PORT oil TAN >5.0 mg/KOH. Renew at earliest.',null,'OPEN'],
  ['A','HV/LV switchboards','Satisfactory','No.2 Ballast Pump HV Fuses — PO 240124, LT 150d.',null,'OPEN'],
  ['B','Gas handling equipment','Satisfactory','LNG Vaporiser IO module delivery chased.','2023-01-26','CLOSED'],
  ['B','Gas combustion unit','Satisfactory','Motor bearing renewed.',null,'CLOSED'],
  ['I','Ballast pumps','NOT SATISFACTORY','No.2 HV Fuses — PO 240124, LT 150d.',null,'OPEN'],
  ['J','Package AC units','Satisfactory','PORT Converter AC leak. ECR AC contactor PO 240146.','2024-03-11','OPEN'],
  ['J','Main AC chiller systems','NOT SATISFACTORY','No.1 Chiller compressor needs replacement.','2024-09-14','OPEN'],
  ['K','ISPS door locks','Unsatisfactory','Spares awaited. PO 220211 partial.','2023-01-28','ONGOING'],
  ['K','Sound reception system','Unsatisfactory','System obsolete.',null,'OPEN'],
  ['F','Lube oil laboratory analysis','Not Satisfactory','EDG high Cu. PORT ST TAN >5.0. BT TAN >4.7.','2024-04-02','IN HAND'],
];

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Users
    const adminHash = await bcrypt.hash('Admin@2025!', 10);
    const suptHash = await bcrypt.hash('Super@2025!', 10);
    const vesselHash = await bcrypt.hash('Vessel@2025!', 10);
    const managerHash = await bcrypt.hash('Manager@2025!', 10);

    const userRes = await client.query(`
      INSERT INTO weekly_plan.users (username, password_hash, display_name, role) VALUES
      ('admin', $1, 'System Admin', 'admin'),
      ('kenzo', $2, 'Kenzo Akinmoladun', 'superintendent'),
      ('ph2_vessel', $3, 'PH2 Vessel', 'vessel'),
      ('manager', $4, 'Fleet Manager', 'manager')
      ON CONFLICT (username) DO NOTHING
      RETURNING id, username
    `, [adminHash, suptHash, vesselHash, managerHash]);
    console.log('Users seeded:', userRes.rowCount);

    // Vessels
    for (const [name, type, imo] of VESSELS) {
      await client.query(
        `INSERT INTO weekly_plan.vessels (name, vessel_type, imo) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [name, type, imo]
      );
    }
    console.log('Vessels seeded:', VESSELS.length);

    // Get vessel IDs for assignments
    const vRes = await client.query('SELECT id, name FROM weekly_plan.vessels ORDER BY id');
    const vesselMap = {};
    vRes.rows.forEach(r => { vesselMap[r.name] = r.id; });

    // Get user IDs
    const uRes = await client.query('SELECT id, username FROM weekly_plan.users');
    const userMap = {};
    uRes.rows.forEach(r => { userMap[r.username] = r.id; });

    // User-vessel assignments (kenzo gets PH2, Rivers, Cross River, AT, AT10)
    if (userMap.kenzo) {
      const kenzoVessels = ['LNG Port Harcourt 2','LNG Rivers','LNG Cross River','LPG Alfred Temile','LPG Alfred Temile 10'];
      for (const vn of kenzoVessels) {
        if (vesselMap[vn]) {
          await client.query(
            `INSERT INTO weekly_plan.user_vessels (user_id, vessel_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [userMap.kenzo, vesselMap[vn]]
          );
        }
      }
    }
    // ph2_vessel gets PH2
    if (userMap.ph2_vessel && vesselMap['LNG Port Harcourt 2']) {
      await client.query(
        `INSERT INTO weekly_plan.user_vessels (user_id, vessel_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userMap.ph2_vessel, vesselMap['LNG Port Harcourt 2']]
      );
    }

    // Agenda templates (same for all vessel types initially)
    for (const [num, title, focus] of AGENDA_ITEMS) {
      await client.query(
        `INSERT INTO weekly_plan.agenda_templates (vessel_type, item_number, title, focus) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        ['ALL', num, title, focus]
      );
    }
    console.log('Agenda templates seeded:', AGENDA_ITEMS.length);

    // PH2 crew
    const ph2Id = vesselMap['LNG Port Harcourt 2'];
    if (ph2Id) {
      for (const [rank, name, joined, dept] of PH2_CREW) {
        const mo = THREE_MO_RANKS.includes(rank) ? 3 : 4;
        await client.query(
          `INSERT INTO weekly_plan.crew (vessel_id, rank, name, joined, department, contract_months) VALUES ($1,$2,$3,$4,$5,$6)`,
          [ph2Id, rank, name, joined, dept, mo]
        );
      }
      console.log('PH2 crew seeded:', PH2_CREW.length);

      // PH2 action items
      for (const [cat, eq, cond, action, reported, status] of PH2_ACTIONS) {
        await client.query(
          `INSERT INTO weekly_plan.action_items (vessel_id, category, equipment, condition, action_plan, date_reported, status) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [ph2Id, cat, eq, cond, action, reported, status]
        );
      }
      console.log('PH2 actions seeded:', PH2_ACTIONS.length);
    }

    await client.query('COMMIT');
    console.log('Seed complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { seed };

if (require.main === module) {
  seed().then(() => process.exit(0)).catch(() => process.exit(1));
}
