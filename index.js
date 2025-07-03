import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import session from 'express-session';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = 3000;

// Middleware setup
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Use session with longer duration and security options
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 6, // 6 hours
    sameSite: 'lax'
  }
}));

// Helper functions
const readJSON = f => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')); }
  catch { return []; }
};
const writeJSON = (f, data) => fs.writeFileSync(path.join(__dirname, f), JSON.stringify(data, null, 2));

// Middleware to protect routes
const requireDoctor = (req, res, next) => {
  if (req.session?.user?.role === 'doctor') return next();
  res.redirect('/login');
};
const requirePatient = (req, res, next) => {
  if (req.session?.user?.role === 'patient') return next();
  res.redirect('/login');
};

// Routes
app.get('/', (req, res) => res.render('about'));
app.get('/login', (req, res) => res.render('login', { message: null }));
app.get('/register', (req, res) => res.render('register'));
app.get('/policy', (req, res) => res.render('policy'));
app.get('/prese', (req, res) => res.render('prese'));
app.get('/contactus', (req, res) => res.render('contactus'));
app.get('/dashboard', (req, res) => res.render('dashboard'));

// Register patient
app.post('/register/patient', async (req, res) => {
  const patients = readJSON('patients.json');
  const { firstName, lastName, dob, gender, email, phone, address, password } = req.body;

  if (patients.some(p => p.email === email)) return res.send('Patient exists');

  patients.push({
    id: Date.now(),
    name: `${firstName} ${lastName}`,
    dob, gender, email, phone, address,
    password: await bcrypt.hash(password, 10),
    role: 'patient'
  });

  writeJSON('patients.json', patients);
  res.redirect('/login');
});

// Register doctor
app.post('/register/doctor', async (req, res) => {
  const doctors = readJSON('doctors.json');
  const { firstName, lastName, specialization, license, experience, hospital, email, phone, address, password } = req.body;

  if (doctors.some(d => d.email === email)) return res.send('Doctor exists');

  doctors.push({
    id: Date.now(),
    name: `${firstName} ${lastName}`,
    specialization, license, experience, hospital,
    email, phone, address,
    password: await bcrypt.hash(password, 10),
    role: 'doctor'
  });

  writeJSON('doctors.json', doctors);
  res.redirect('/login');
});

// Login
app.post('/check', async (req, res) => {
  const { email, password, role } = req.body;
  const users = readJSON(`${role}s.json`);
  const user = users.find(u => u.email === email);

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.render('login', { message: 'Invalid credentials' });
  }

  req.session.user = { id: user.id, name: user.name, role: user.role };
  res.redirect(`/${role}`);
});

// Doctor Dashboard
app.get('/doctor', requireDoctor, (req, res) => {
  const appointments = readJSON('appointments.json').filter(a => a.doctorId === req.session.user.id);
  const today = new Date().toISOString().split('T')[0];

  const stats = {
    todayCount: appointments.filter(a => a.date === today).length,
    todayConfirmed: appointments.filter(a => a.date === today && a.status === 'Confirmed').length,
    weekCount: appointments.length,
    weekDiff: 0,
    patientTotal: new Set(appointments.map(a => a.patientId)).size,
    patientNew: appointments.filter(a => new Date(a.date) >= new Date(today.slice(0, 7) + '-01')).length,
    prescriptionTotal: appointments.filter(a => a.precautions).length,
    prescriptionWeekly: 0
  };

  const patients = appointments.map(a => ({
    patientName: a.patientName,
    patientId: a.patientId,
    date: a.date,
    time: a.time,
    status: a.status,
    precautions: a.precautions || null,
    prescription: a.prescription || null,
    reason: a.reason,
    id: a.id
  }));

  res.render('doctor', {
    doctor: req.session.user,
    appointments,
    stats,
    patients
  });
});

// Update appointment with precautions & prescription
app.post('/doctor/appointment/:id/precautions', requireDoctor, (req, res) => {
  const appointments = readJSON('appointments.json');
  const appt = appointments.find(a => a.id === +req.params.id && a.doctorId === req.session.user.id);

  if (!appt) return res.sendStatus(404);

  appt.precautions = req.body.precautions;
  const meds = req.body.medications || [];
  const times = req.body.timings || [];

  // Combine medications and timings into string prescription
  const combinedPrescription = Array.isArray(meds) ? meds.map((med, i) => `${med} - ${times[i] || ''}`).join(', ') : `${meds} - ${times}`;
  appt.prescription = combinedPrescription;
  appt.status = 'Completed';

  writeJSON('appointments.json', appointments);
  res.redirect('/doctor');
});

// Delete appointment (doctor)
app.post('/doctor/appointment/:id/delete', requireDoctor, (req, res) => {
  let appointments = readJSON('appointments.json');
  appointments = appointments.filter(a => !(a.id === +req.params.id && a.doctorId === req.session.user.id));
  writeJSON('appointments.json', appointments);
  res.redirect('/doctor');
});

// Patient Dashboard
app.get('/patient', requirePatient, (req, res) => {
  const appointments = readJSON('appointments.json').filter(a => a.patientId === req.session.user.id);
  const doctors = readJSON('doctors.json');
  const prescriptions = appointments.filter(a => a.precautions || a.prescription);

  res.render('patient', {
    patient: req.session.user,
    appointments,
    prescriptions,
    doctors
  });
});

// Book appointment
app.post('/patient/book', requirePatient, (req, res) => {
  const { doctorId, date, time, reason } = req.body;
  const doctors = readJSON('doctors.json');
  const doctor = doctors.find(d => d.id === +doctorId);
  if (!doctor) return res.send('Invalid doctor');

  const appointments = readJSON('appointments.json');
  appointments.push({
    id: Date.now(),
    doctorId: +doctorId,
    doctorName: doctor.name,
    specialty: doctor.specialization,
    patientId: req.session.user.id,
    patientName: req.session.user.name,
    date, time, reason,
    status: 'Scheduled'
  });

  writeJSON('appointments.json', appointments);
  res.redirect('/patient');
});

// Logout
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// Start server
app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
