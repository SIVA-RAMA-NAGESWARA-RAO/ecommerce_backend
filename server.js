// EcoLearn Platform — Express Backend
// Run: node server.js
// Requires MySQL running with ecolearn database (run schema.sql first)

require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'ecolearn-secret-change-in-production';

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static uploads
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
app.use('/uploads', express.static(UPLOAD_DIR));

// Serve frontend
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND_DIR));

// ── MySQL Pool ──────────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'ecolearn',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: '+00:00'
});

// ── Multer Storage ──────────────────────────────────────────────────────────
function makeStorage(subfolder) {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_DIR, subfolder);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, uuidv4() + ext);
    }
  });
}

const uploadThumb = multer({ storage: makeStorage('thumbnails'), limits: { fileSize: 10 * 1024 * 1024 } });
const uploadMedia = multer({ storage: makeStorage('media'), limits: { fileSize: 500 * 1024 * 1024 } });
const uploadAssign = multer({ storage: makeStorage('assignments'), limits: { fileSize: 50 * 1024 * 1024 } });
const uploadAvatar = multer({ storage: makeStorage('avatars'), limits: { fileSize: 5 * 1024 * 1024 } });

// ── Auth Middleware ─────────────────────────────────────────────────────────
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(h.split(' ')[1], JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ── Helpers ─────────────────────────────────────────────────────────────────
async function log(userId, action, entityType, entityId, meta) {
  try {
    await pool.query(
      'INSERT INTO activity_log (user_id, action, entity_type, entity_id, meta) VALUES (?,?,?,?,?)',
      [userId, action, entityType || null, entityId || null, meta ? JSON.stringify(meta) : null]
    );
  } catch {}
}

async function recalcModuleProgress(userId, moduleId) {
  const [items] = await pool.query('SELECT id FROM module_items WHERE module_id=?', [moduleId]);
  if (!items.length) return;
  const [done] = await pool.query(
    'SELECT COUNT(*) as c FROM item_progress WHERE user_id=? AND module_item_id IN (?) AND is_completed=1',
    [userId, items.map(i => i.id)]
  );
  const pct = Math.round((done[0].c / items.length) * 100);
  const completed = pct >= 100;
  await pool.query(
    `INSERT INTO module_progress (user_id, module_id, percent_complete, is_completed, completed_at, points_awarded)
     VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE percent_complete=?, is_completed=?, completed_at=IF(?=1 AND completed_at IS NULL, NOW(), completed_at), points_awarded=IF(?=1 AND points_awarded=0, (SELECT points_reward FROM modules WHERE id=?), points_awarded)`,
    [userId, moduleId, pct, completed, completed ? new Date() : null, completed ? 1 : 0,
     pct, completed, completed ? 1 : 0, completed ? 1 : 0, moduleId]
  );
  if (completed) {
    const [[mod]] = await pool.query('SELECT points_reward FROM modules WHERE id=?', [moduleId]);
    await pool.query('UPDATE users SET eco_points = eco_points + ? WHERE id=? AND NOT EXISTS (SELECT 1 FROM module_progress WHERE user_id=? AND module_id=? AND points_awarded>0)', [mod.points_reward, userId, userId, moduleId]);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ════════════════════════════════════════════════════════════════════════════

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    const [[exist]] = await pool.query('SELECT id FROM users WHERE email=?', [email]);
    if (exist) return res.status(409).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, 12);
    const userRole = role === 'admin' ? 'student' : (role || 'student'); // prevent self-admin
    const [r] = await pool.query('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)', [name, email, hash, userRole]);
    const token = jwt.sign({ id: r.insertId, role: userRole, name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: r.insertId, name, email, role: userRole, eco_points: 0 } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const [[user]] = await pool.query('SELECT * FROM users WHERE email=?', [email]);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    await log(user.id, 'login', null, null);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, eco_points: user.eco_points, avatar_url: user.avatar_url } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get profile
app.get('/api/auth/me', auth, async (req, res) => {
  const [[user]] = await pool.query('SELECT id,name,email,role,eco_points,avatar_url,created_at FROM users WHERE id=?', [req.user.id]);
  res.json(user);
});

// Update avatar
app.post('/api/auth/avatar', auth, uploadAvatar.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = `/uploads/avatars/${req.file.filename}`;
  await pool.query('UPDATE users SET avatar_url=? WHERE id=?', [url, req.user.id]);
  res.json({ avatar_url: url });
});

// ════════════════════════════════════════════════════════════════════════════
//  MODULES
// ════════════════════════════════════════════════════════════════════════════

// List modules (students see published, admin sees all)
app.get('/api/modules', auth, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const { q, topic } = req.query;
    let sql = `SELECT m.*, u.name as creator_name,
      (SELECT COUNT(*) FROM module_items WHERE module_id=m.id) as item_count,
      (SELECT percent_complete FROM module_progress WHERE user_id=? AND module_id=m.id) as my_progress,
      (SELECT is_completed FROM module_progress WHERE user_id=? AND module_id=m.id) as my_completed
      FROM modules m JOIN users u ON u.id=m.created_by
      WHERE 1=1`;
    const params = [req.user.id, req.user.id];
    if (!isAdmin) { sql += ' AND m.is_published=1'; }
    if (topic && topic !== 'all') { sql += ' AND m.topic=?'; params.push(topic); }
    if (q) { sql += ' AND (m.title LIKE ? OR m.description LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
    sql += ' ORDER BY m.order_index ASC, m.created_at DESC';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get single module with items
app.get('/api/modules/:id', auth, async (req, res) => {
  try {
    const [[mod]] = await pool.query(
      `SELECT m.*, u.name as creator_name,
       (SELECT percent_complete FROM module_progress WHERE user_id=? AND module_id=m.id) as my_progress,
       (SELECT is_completed FROM module_progress WHERE user_id=? AND module_id=m.id) as my_completed
       FROM modules m JOIN users u ON u.id=m.created_by WHERE m.id=?`,
      [req.user.id, req.user.id, req.params.id]
    );
    if (!mod) return res.status(404).json({ error: 'Not found' });
    if (!mod.is_published && req.user.role !== 'admin') return res.status(403).json({ error: 'Not published' });
    const [items] = await pool.query(
      `SELECT mi.*, ip.is_completed as done, ip.watch_seconds
       FROM module_items mi
       LEFT JOIN item_progress ip ON ip.module_item_id=mi.id AND ip.user_id=?
       WHERE mi.module_id=? ORDER BY mi.order_index ASC`,
      [req.user.id, req.params.id]
    );
    const [quizzes] = await pool.query(
      'SELECT id, title, is_published FROM quizzes WHERE module_id=?',
      [req.params.id]
    );
    res.json({ ...mod, items, quizzes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create module (admin)
app.post('/api/modules', auth, adminOnly, uploadThumb.single('thumbnail'), async (req, res) => {
  try {
    const { title, description, topic, level, points_reward } = req.body;
    const thumb = req.file ? `/uploads/thumbnails/${req.file.filename}` : null;
    const [r] = await pool.query(
      'INSERT INTO modules (title,description,topic,level,thumbnail_url,points_reward,created_by) VALUES (?,?,?,?,?,?,?)',
      [title, description, topic || 'other', level || 'Beginner', thumb, points_reward || 100, req.user.id]
    );
    await log(req.user.id, 'create_module', 'module', r.insertId);
    res.json({ id: r.insertId, message: 'Module created' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update module
app.put('/api/modules/:id', auth, adminOnly, uploadThumb.single('thumbnail'), async (req, res) => {
  try {
    const { title, description, topic, level, points_reward, is_published } = req.body;
    const fields = {};
    if (title !== undefined) fields.title = title;
    if (description !== undefined) fields.description = description;
    if (topic !== undefined) fields.topic = topic;
    if (level !== undefined) fields.level = level;
    if (points_reward !== undefined) fields.points_reward = points_reward;
    if (req.file) fields.thumbnail_url = `/uploads/thumbnails/${req.file.filename}`;
    if (is_published !== undefined) fields.is_published = is_published === 'true' || is_published === true ? 1 : 0;
    if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'No fields to update' });
    const sets = Object.keys(fields).map(k => `${k}=?`).join(',');
    await pool.query(`UPDATE modules SET ${sets} WHERE id=?`, [...Object.values(fields), req.params.id]);
    res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete module
app.delete('/api/modules/:id', auth, adminOnly, async (req, res) => {
  await pool.query('DELETE FROM modules WHERE id=?', [req.params.id]);
  res.json({ message: 'Deleted' });
});

// Add item to module
app.post('/api/modules/:id/items', auth, adminOnly, uploadMedia.single('file'), async (req, res) => {
  try {
    const { type, title, content, order_index, duration_seconds } = req.body;
    const fileUrl = req.file ? `/uploads/media/${req.file.filename}` : null;
    const [r] = await pool.query(
      'INSERT INTO module_items (module_id,type,title,content,file_url,order_index,duration_seconds) VALUES (?,?,?,?,?,?,?)',
      [req.params.id, type, title, content || null, fileUrl, order_index || 0, duration_seconds || 0]
    );
    res.json({ id: r.insertId, file_url: fileUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete module item
app.delete('/api/modules/:id/items/:itemId', auth, adminOnly, async (req, res) => {
  await pool.query('DELETE FROM module_items WHERE id=? AND module_id=?', [req.params.itemId, req.params.id]);
  res.json({ message: 'Deleted' });
});

// Mark item complete
app.post('/api/modules/:id/items/:itemId/complete', auth, async (req, res) => {
  try {
    const { watch_seconds } = req.body;
    await pool.query(
      `INSERT INTO item_progress (user_id, module_item_id, is_completed, watch_seconds, completed_at)
       VALUES (?,?,1,?,NOW()) ON DUPLICATE KEY UPDATE is_completed=1, watch_seconds=GREATEST(watch_seconds,?), completed_at=IF(completed_at IS NULL,NOW(),completed_at)`,
      [req.user.id, req.params.itemId, watch_seconds || 0, watch_seconds || 0]
    );
    await recalcModuleProgress(req.user.id, req.params.id);
    await log(req.user.id, 'complete_item', 'module_item', req.params.itemId);
    res.json({ message: 'Marked complete' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  QUIZZES
// ════════════════════════════════════════════════════════════════════════════

// List quizzes
app.get('/api/quizzes', auth, async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const [rows] = await pool.query(
    `SELECT q.*, m.title as module_title, u.name as creator_name,
     (SELECT COUNT(*) FROM quiz_questions WHERE quiz_id=q.id) as question_count,
     (SELECT score_percent FROM quiz_attempts WHERE user_id=? AND quiz_id=q.id ORDER BY submitted_at DESC LIMIT 1) as my_last_score
     FROM quizzes q LEFT JOIN modules m ON m.id=q.module_id JOIN users u ON u.id=q.created_by
     WHERE 1=1 ${isAdmin ? '' : 'AND q.is_published=1'}
     ORDER BY q.created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

// Get quiz with questions (for taking)
app.get('/api/quizzes/:id', auth, async (req, res) => {
  try {
    const [[quiz]] = await pool.query('SELECT * FROM quizzes WHERE id=?', [req.params.id]);
    if (!quiz) return res.status(404).json({ error: 'Not found' });
    if (!quiz.is_published && req.user.role !== 'admin') return res.status(403).json({ error: 'Not published' });
    const [questions] = await pool.query(
      'SELECT * FROM quiz_questions WHERE quiz_id=? ORDER BY order_index',
      [req.params.id]
    );
    for (const q of questions) {
      const [opts] = await pool.query(
        `SELECT id, option_text, order_index ${req.user.role === 'admin' ? ', is_correct' : ''} FROM quiz_options WHERE question_id=? ORDER BY order_index`,
        [q.id]
      );
      q.options = opts;
    }
    res.json({ ...quiz, questions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create quiz (admin)
app.post('/api/quizzes', auth, adminOnly, async (req, res) => {
  try {
    const { module_id, title, description, pass_score_percent, time_limit_minutes, questions } = req.body;
    const [r] = await pool.query(
      'INSERT INTO quizzes (module_id,title,description,pass_score_percent,time_limit_minutes,created_by) VALUES (?,?,?,?,?,?)',
      [module_id || null, title, description || null, pass_score_percent || 60, time_limit_minutes || null, req.user.id]
    );
    const qid = r.insertId;
    if (questions && questions.length) {
      for (let i = 0; i < questions.length; i++) {
        const qq = questions[i];
        const [qr] = await pool.query(
          'INSERT INTO quiz_questions (quiz_id,question_text,question_type,order_index,points) VALUES (?,?,?,?,?)',
          [qid, qq.question_text, qq.question_type || 'mcq', i + 1, qq.points || 10]
        );
        if (qq.options) {
          for (let j = 0; j < qq.options.length; j++) {
            const o = qq.options[j];
            await pool.query(
              'INSERT INTO quiz_options (question_id,option_text,is_correct,order_index) VALUES (?,?,?,?)',
              [qr.insertId, o.option_text, o.is_correct ? 1 : 0, j + 1]
            );
          }
        }
      }
    }
    res.json({ id: qid, message: 'Quiz created' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Publish/unpublish quiz
app.patch('/api/quizzes/:id/publish', auth, adminOnly, async (req, res) => {
  await pool.query('UPDATE quizzes SET is_published=? WHERE id=?', [req.body.is_published ? 1 : 0, req.params.id]);
  res.json({ message: 'Updated' });
});

// Delete quiz
app.delete('/api/quizzes/:id', auth, adminOnly, async (req, res) => {
  await pool.query('DELETE FROM quizzes WHERE id=?', [req.params.id]);
  res.json({ message: 'Deleted' });
});

// Submit quiz attempt
app.post('/api/quizzes/:id/submit', auth, async (req, res) => {
  try {
    const { answers } = req.body; // [{question_id, selected_option_id, text_answer}]
    const [[quiz]] = await pool.query('SELECT * FROM quizzes WHERE id=?', [req.params.id]);
    const [questions] = await pool.query('SELECT * FROM quiz_questions WHERE quiz_id=?', [req.params.id]);
    let totalPts = 0, earnedPts = 0;
    const results = [];
    for (const q of questions) {
      totalPts += q.points;
      const ans = answers?.find(a => a.question_id == q.id);
      let correct = null, pts = 0;
      if (q.question_type === 'mcq' && ans?.selected_option_id) {
        const [[opt]] = await pool.query('SELECT is_correct FROM quiz_options WHERE id=?', [ans.selected_option_id]);
        correct = opt?.is_correct ? true : false;
        pts = correct ? q.points : 0;
        earnedPts += pts;
      }
      results.push({ question_id: q.id, selected_option_id: ans?.selected_option_id, text_answer: ans?.text_answer, is_correct: correct, points_earned: pts });
    }
    const scorePct = totalPts > 0 ? Math.round((earnedPts / totalPts) * 100) : 0;
    const passed = scorePct >= quiz.pass_score_percent;
    const [at] = await pool.query(
      'INSERT INTO quiz_attempts (user_id,quiz_id,score_percent,total_points,earned_points,passed) VALUES (?,?,?,?,?,?)',
      [req.user.id, req.params.id, scorePct, totalPts, earnedPts, passed ? 1 : 0]
    );
    for (const r of results) {
      await pool.query(
        'INSERT INTO quiz_answers (attempt_id,question_id,selected_option_id,text_answer,is_correct,points_earned) VALUES (?,?,?,?,?,?)',
        [at.insertId, r.question_id, r.selected_option_id || null, r.text_answer || null, r.is_correct, r.points_earned]
      );
    }
    if (passed) {
      await pool.query('UPDATE users SET eco_points=eco_points+? WHERE id=?', [earnedPts, req.user.id]);
    }
    await log(req.user.id, 'submit_quiz', 'quiz', req.params.id, { score: scorePct, passed });
    res.json({ score_percent: scorePct, passed, earned_points: earnedPts, total_points: totalPts, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  ASSIGNMENTS
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/assignments', auth, async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const [rows] = await pool.query(
    `SELECT a.*, m.title as module_title,
     (SELECT status FROM assignment_submissions WHERE assignment_id=a.id AND user_id=?) as my_status,
     (SELECT score FROM assignment_submissions WHERE assignment_id=a.id AND user_id=?) as my_score,
     (SELECT COUNT(*) FROM assignment_submissions WHERE assignment_id=a.id) as submission_count
     FROM assignments a LEFT JOIN modules m ON m.id=a.module_id
     WHERE ${isAdmin ? '1=1' : 'a.is_published=1'}
     ORDER BY a.created_at DESC`,
    [req.user.id, req.user.id]
  );
  res.json(rows);
});

app.post('/api/assignments', auth, adminOnly, async (req, res) => {
  const { module_id, title, description, due_date, max_score } = req.body;
  const [r] = await pool.query(
    'INSERT INTO assignments (module_id,title,description,due_date,max_score,is_published,created_by) VALUES (?,?,?,?,?,1,?)',
    [module_id || null, title, description, due_date || null, max_score || 100, req.user.id]
  );
  res.json({ id: r.insertId, message: 'Assignment created' });
});

app.delete('/api/assignments/:id', auth, adminOnly, async (req, res) => {
  await pool.query('DELETE FROM assignments WHERE id=?', [req.params.id]);
  res.json({ message: 'Deleted' });
});

// Submit assignment (student uploads file or text)
app.post('/api/assignments/:id/submit', auth, uploadAssign.single('file'), async (req, res) => {
  try {
    const fileUrl = req.file ? `/uploads/assignments/${req.file.filename}` : null;
    const { text_response } = req.body;
    await pool.query(
      `INSERT INTO assignment_submissions (assignment_id,user_id,file_url,text_response,status)
       VALUES (?,?,?,?,'submitted') ON DUPLICATE KEY UPDATE file_url=?,text_response=?,submitted_at=NOW(),status='submitted'`,
      [req.params.id, req.user.id, fileUrl, text_response || null, fileUrl, text_response || null]
    );
    await log(req.user.id, 'submit_assignment', 'assignment', req.params.id);
    res.json({ message: 'Submitted', file_url: fileUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Grade assignment (admin)
app.patch('/api/assignments/:id/submissions/:uid/grade', auth, adminOnly, async (req, res) => {
  const { score, feedback } = req.body;
  await pool.query(
    `UPDATE assignment_submissions SET score=?,feedback=?,status='graded',graded_at=NOW() WHERE assignment_id=? AND user_id=?`,
    [score, feedback, req.params.id, req.params.uid]
  );
  if (score) await pool.query('UPDATE users SET eco_points=eco_points+? WHERE id=?', [Math.floor(score / 10), req.params.uid]);
  res.json({ message: 'Graded' });
});

// Get submissions for an assignment (admin)
app.get('/api/assignments/:id/submissions', auth, adminOnly, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT s.*, u.name, u.email FROM assignment_submissions s JOIN users u ON u.id=s.user_id WHERE s.assignment_id=?`,
    [req.params.id]
  );
  res.json(rows);
});

// ════════════════════════════════════════════════════════════════════════════
//  USERS / LEADERBOARD
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/leaderboard', auth, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, name, eco_points, avatar_url, (SELECT COUNT(*) FROM module_progress WHERE user_id=users.id AND is_completed=1) as modules_done FROM users WHERE role="student" ORDER BY eco_points DESC LIMIT 20'
  );
  res.json(rows);
});

app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  const { q } = req.query;
  let sql = 'SELECT id,name,email,role,eco_points,created_at FROM users WHERE 1=1';
  const params = [];
  if (q) { sql += ' AND (name LIKE ? OR email LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY created_at DESC';
  const [rows] = await pool.query(sql, params);
  res.json(rows);
});

app.patch('/api/admin/users/:id', auth, adminOnly, async (req, res) => {
  const { role } = req.body;
  await pool.query('UPDATE users SET role=? WHERE id=?', [role, req.params.id]);
  res.json({ message: 'Updated' });
});

// ════════════════════════════════════════════════════════════════════════════
//  ADMIN ANALYTICS
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/analytics', auth, adminOnly, async (req, res) => {
  const [[{ total_users }]] = await pool.query('SELECT COUNT(*) as total_users FROM users');
  const [[{ total_modules }]] = await pool.query('SELECT COUNT(*) as total_modules FROM modules');
  const [[{ published_modules }]] = await pool.query('SELECT COUNT(*) as published_modules FROM modules WHERE is_published=1');
  const [[{ total_submissions }]] = await pool.query('SELECT COUNT(*) as total_submissions FROM assignment_submissions');
  const [[{ quiz_attempts }]] = await pool.query('SELECT COUNT(*) as quiz_attempts FROM quiz_attempts');
  const [[{ avg_score }]] = await pool.query('SELECT ROUND(AVG(score_percent),1) as avg_score FROM quiz_attempts');
  const [top_modules] = await pool.query(
    'SELECT m.title, COUNT(mp.user_id) as completions FROM modules m LEFT JOIN module_progress mp ON mp.module_id=m.id AND mp.is_completed=1 GROUP BY m.id ORDER BY completions DESC LIMIT 5'
  );
  const [recent_activity] = await pool.query(
    'SELECT al.*, u.name FROM activity_log al JOIN users u ON u.id=al.user_id ORDER BY al.created_at DESC LIMIT 20'
  );
  res.json({ total_users, total_modules, published_modules, total_submissions, quiz_attempts, avg_score, top_modules, recent_activity });
});

// Search (global)
app.get('/api/search', auth, async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json({ modules: [], quizzes: [], assignments: [] });
  const isAdmin = req.user.role === 'admin';
  const [modules] = await pool.query(
    `SELECT id,title,topic,level,'module' as type FROM modules WHERE (title LIKE ? OR description LIKE ?) ${isAdmin ? '' : 'AND is_published=1'} LIMIT 5`,
    [`%${q}%`, `%${q}%`]
  );
  const [quizzes] = await pool.query(
    `SELECT id,title,'quiz' as type FROM quizzes WHERE title LIKE ? ${isAdmin ? '' : 'AND is_published=1'} LIMIT 5`,
    [`%${q}%`]
  );
  const [assignments] = await pool.query(
    `SELECT id,title,'assignment' as type FROM assignments WHERE title LIKE ? ${isAdmin ? '' : 'AND is_published=1'} LIMIT 5`,
    [`%${q}%`]
  );
  res.json({ modules, quizzes, assignments });
});

// ── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`\n🌿 EcoLearn running at http://localhost:${port}`);
    console.log(`   MySQL: ${process.env.DB_HOST || 'localhost'} / ${process.env.DB_NAME || 'ecolearn'}`);
    console.log(`   Admin: admin@ecolearn.com  |  Student: student@ecolearn.com`);
    console.log(`   Default password for both: Admin@123\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const nextPort = port + 1;
      console.warn(`Port ${port} is already in use. Trying ${nextPort}...`);
      startServer(nextPort);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
}

startServer(PORT);
