-- EcoLearn Platform — Full MySQL Schema
-- Run this in MySQL Workbench to set up the database

CREATE DATABASE IF NOT EXISTS ecolearn CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE ecolearn;

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(180) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin','student','teacher') DEFAULT 'student',
  avatar_url VARCHAR(500) DEFAULT NULL,
  eco_points INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_email (email),
  INDEX idx_role (role)
);

-- Modules table (groups of content - videos, images, text)
CREATE TABLE IF NOT EXISTS modules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  topic ENUM('energy','waste','diet','water','biodiversity','cities','other') DEFAULT 'other',
  level ENUM('Beginner','Intermediate','Advanced') DEFAULT 'Beginner',
  thumbnail_url VARCHAR(500) DEFAULT NULL,
  points_reward INT DEFAULT 100,
  is_published BOOLEAN DEFAULT FALSE,
  order_index INT DEFAULT 0,
  created_by INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_topic (topic),
  INDEX idx_published (is_published)
);

-- Module items (videos, images, text blocks inside a module)
CREATE TABLE IF NOT EXISTS module_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  module_id INT NOT NULL,
  type ENUM('video','image','text','link') NOT NULL,
  title VARCHAR(200) NOT NULL,
  content TEXT,         -- text content or URL/path
  file_url VARCHAR(500) DEFAULT NULL,
  duration_seconds INT DEFAULT 0,  -- for videos
  order_index INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE,
  INDEX idx_module (module_id)
);

-- Quizzes
CREATE TABLE IF NOT EXISTS quizzes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  module_id INT DEFAULT NULL,  -- can be standalone or tied to a module
  title VARCHAR(200) NOT NULL,
  description TEXT,
  time_limit_minutes INT DEFAULT NULL,
  pass_score_percent INT DEFAULT 60,
  is_published BOOLEAN DEFAULT FALSE,
  created_by INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id),
  INDEX idx_module (module_id)
);

-- Quiz questions
CREATE TABLE IF NOT EXISTS quiz_questions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  quiz_id INT NOT NULL,
  question_text TEXT NOT NULL,
  question_type ENUM('mcq','multi','short_answer','file_upload') DEFAULT 'mcq',
  order_index INT DEFAULT 0,
  points INT DEFAULT 10,
  FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE,
  INDEX idx_quiz (quiz_id)
);

-- Quiz options (for MCQ questions)
CREATE TABLE IF NOT EXISTS quiz_options (
  id INT AUTO_INCREMENT PRIMARY KEY,
  question_id INT NOT NULL,
  option_text VARCHAR(500) NOT NULL,
  is_correct BOOLEAN DEFAULT FALSE,
  order_index INT DEFAULT 0,
  FOREIGN KEY (question_id) REFERENCES quiz_questions(id) ON DELETE CASCADE
);

-- Student progress on module items
CREATE TABLE IF NOT EXISTS item_progress (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  module_item_id INT NOT NULL,
  is_completed BOOLEAN DEFAULT FALSE,
  watch_seconds INT DEFAULT 0,   -- how many seconds of video watched
  completed_at DATETIME DEFAULT NULL,
  UNIQUE KEY uq_user_item (user_id, module_item_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (module_item_id) REFERENCES module_items(id) ON DELETE CASCADE
);

-- Module completion summary
CREATE TABLE IF NOT EXISTS module_progress (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  module_id INT NOT NULL,
  percent_complete DECIMAL(5,2) DEFAULT 0.00,
  is_completed BOOLEAN DEFAULT FALSE,
  completed_at DATETIME DEFAULT NULL,
  points_awarded INT DEFAULT 0,
  UNIQUE KEY uq_user_module (user_id, module_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE
);

-- Quiz submissions / attempts
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  quiz_id INT NOT NULL,
  score_percent DECIMAL(5,2) DEFAULT 0,
  total_points INT DEFAULT 0,
  earned_points INT DEFAULT 0,
  passed BOOLEAN DEFAULT FALSE,
  submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE,
  INDEX idx_user_quiz (user_id, quiz_id)
);

-- Individual answer records
CREATE TABLE IF NOT EXISTS quiz_answers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  attempt_id INT NOT NULL,
  question_id INT NOT NULL,
  selected_option_id INT DEFAULT NULL,
  text_answer TEXT DEFAULT NULL,
  file_url VARCHAR(500) DEFAULT NULL,
  is_correct BOOLEAN DEFAULT NULL,
  points_earned INT DEFAULT 0,
  FOREIGN KEY (attempt_id) REFERENCES quiz_attempts(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES quiz_questions(id),
  FOREIGN KEY (selected_option_id) REFERENCES quiz_options(id)
);

-- Assignments / Homework
CREATE TABLE IF NOT EXISTS assignments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  module_id INT DEFAULT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  due_date DATETIME DEFAULT NULL,
  max_score INT DEFAULT 100,
  is_published BOOLEAN DEFAULT FALSE,
  created_by INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Student assignment submissions
CREATE TABLE IF NOT EXISTS assignment_submissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  assignment_id INT NOT NULL,
  user_id INT NOT NULL,
  file_url VARCHAR(500) DEFAULT NULL,
  text_response TEXT DEFAULT NULL,
  score INT DEFAULT NULL,
  feedback TEXT DEFAULT NULL,
  status ENUM('submitted','graded','returned') DEFAULT 'submitted',
  submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  graded_at DATETIME DEFAULT NULL,
  FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_sub (assignment_id, user_id)
);

-- Activity log (for admin analytics)
CREATE TABLE IF NOT EXISTS activity_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50) DEFAULT NULL,
  entity_id INT DEFAULT NULL,
  meta JSON DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user (user_id),
  INDEX idx_created (created_at)
);

-- Seed default admin account (password: Admin@123)
INSERT IGNORE INTO users (name, email, password_hash, role) VALUES
('Platform Admin', 'admin@ecolearn.com', '$2a$12$GkfA5CzBiuMjYq5pMV.dQeFtVb4VJ2rG8Og4DaHH7bS5rQGpYAB7a', 'admin'),
('Demo Student', 'student@ecolearn.com', '$2a$12$GkfA5CzBiuMjYq5pMV.dQeFtVb4VJ2rG8Og4DaHH7bS5rQGpYAB7a', 'student');

-- Sample module
INSERT IGNORE INTO modules (id, title, description, topic, level, points_reward, is_published, created_by) VALUES
(1, 'Renewable Energy Fundamentals', 'Learn how solar, wind, and hydro power are transforming global energy systems and what you can do to support the transition.', 'energy', 'Beginner', 150, TRUE, 1);

INSERT IGNORE INTO module_items (module_id, type, title, content, order_index) VALUES
(1, 'text', 'Introduction to Renewable Energy', 'Renewable energy comes from natural sources that are replenished faster than they are consumed. The main types are solar, wind, hydroelectric, geothermal, and biomass. Unlike fossil fuels, these sources produce little to no greenhouse gas emissions during operation.', 1),
(1, 'text', 'Why Renewable Energy Matters', 'Fossil fuels — coal, oil, and gas — currently supply about 80% of the world''s energy. Burning them releases CO₂ and other greenhouse gases that are warming the planet. Transitioning to renewables is one of the most impactful things humanity can do to address the climate crisis.', 2),
(1, 'text', 'Solar Energy Explained', 'Photovoltaic (PV) solar cells convert sunlight directly into electricity. A typical home solar system can offset 3–4 tonnes of CO₂ per year. Solar costs have fallen by 90% since 2010, making it the cheapest source of electricity in history in many regions.', 3);

INSERT IGNORE INTO quizzes (id, module_id, title, description, pass_score_percent, is_published, created_by) VALUES
(1, 1, 'Renewable Energy Quiz', 'Test your understanding of the fundamentals covered in this module.', 60, TRUE, 1);

INSERT IGNORE INTO quiz_questions (id, quiz_id, question_text, question_type, order_index, points) VALUES
(1, 1, 'Which energy source has seen costs fall by over 90% since 2010?', 'mcq', 1, 10),
(2, 1, 'What percentage of world energy currently comes from fossil fuels?', 'mcq', 2, 10),
(3, 1, 'What does PV stand for in solar PV cells?', 'mcq', 3, 10);

INSERT IGNORE INTO quiz_options (question_id, option_text, is_correct, order_index) VALUES
(1, 'Wind energy', FALSE, 1),(1, 'Solar energy', TRUE, 2),(1, 'Hydroelectric', FALSE, 3),(1, 'Geothermal', FALSE, 4),
(2, 'About 40%', FALSE, 1),(2, 'About 60%', FALSE, 2),(2, 'About 80%', TRUE, 3),(2, 'About 95%', FALSE, 4),
(3, 'Photovoltaic', TRUE, 1),(3, 'Pressure Voltage', FALSE, 2),(3, 'Power Variable', FALSE, 3),(3, 'Proton Value', FALSE, 4);
