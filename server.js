require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const cron = require('node-cron');
const PDFDocument = require('pdfkit');

const { read, write, uuid } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_, file, cb) =>
    cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_'))
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
}));

app.use('/uploads', express.static(uploadDir));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'public', 'public', 'images')));

function safeUser(u) {
  return u && {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role
  };
}

function auth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function currentUser(req) {
  const db = read();
  return db.users.find(u => u.id === req.session.userId);
}

function propertyAccess(user, p) {
  return (
    user.role === 'administrator' ||
    p.landlordId === user.id ||
    p.agentId === user.id ||
    (p.tenantIds || []).includes(user.id) ||
    user.role === 'contractor'
  );
}

function audit(db, action, user) {
  db.audit = db.audit || [];
  db.audit.unshift({
    id: uuid(),
    at: new Date().toISOString(),
    action,
    user: user?.email
  });
}

function publicLayout(title, body) {
  return `
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>${title}</title>
      <link rel="stylesheet" href="/styles.css">
    </head>
    <body>
      <div class="public-page">
        <h1>${title}</h1>
        ${body}
      </div>
    </body>
    </html>
  `;
}

function findLink(db, token, type) {
  return (db.links || []).find(l => l.token === token && l.type === type && l.active);
}

/* AUTH */

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const db = read();

  const user = db.users.find(
    u => u.email.toLowerCase() === (email || '').toLowerCase()
  );

  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid login' });
  }

  req.session.userId = user.id;
  res.json({ user: safeUser(user) });
});

app.post('/api/logout', (req, res) =>
  req.session.destroy(() => res.json({ ok: true }))
);

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  res.json({ user: safeUser(currentUser(req)) });
});

/* MAIN APP DATA */

app.get('/api/app', auth, (req, res) => {
  const db = read();
  db.links = db.links || [];
  db.contractorJobs = db.contractorJobs || [];

  const user = currentUser(req);
  const properties = db.properties.filter(p => propertyAccess(user, p));
  const propertyIds = properties.map(p => p.id);

  res.json({
    user: safeUser(user),
    users: user.role === 'administrator' ? db.users.map(safeUser) : [],
    properties,
    documents: db.documents.filter(d => propertyIds.includes(d.propertyId)),
    contractors: db.contractors || [],
    contractorJobs: db.contractorJobs.filter(j =>
      user.role === 'administrator' || propertyIds.includes(j.propertyId)
    ),
    reviews: (db.reviews || []).filter(r => propertyIds.includes(r.propertyId)),
    maintenance: (db.maintenance || []).filter(m => propertyIds.includes(m.propertyId)),
    reminders: db.reminders || [],
    audit: user.role === 'administrator' ? (db.audit || []).slice(0, 100) : []
  });
});

/* PROPERTIES */

app.post('/api/properties', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  const p = {
    id: uuid(),
    address: req.body.address,
    type: req.body.type || '',
landlordId: user.role === 'administrator' && req.body.landlordId
  ? req.body.landlordId
  : user.id,
    agentId: req.body.agentId || '',
    tenantIds: [],
    status: 'Needs Review',
    lastConditionReview: '',
    nextConditionReview: ''
  };

  db.properties.push(p);
  audit(db, 'Created property ' + p.address, user);
  write(db);

  res.json(p);
});

/* DOCUMENTS */

app.post('/api/documents', auth, upload.single('file'), (req, res) => {
  const db = read();
  const user = currentUser(req);

  const p = db.properties.find(x => x.id === req.body.propertyId);

  if (!p || !propertyAccess(user, p)) {
    return res.status(403).json({ error: 'No access' });
  }

  const d = {
    id: uuid(),
    propertyId: p.id,
    category: req.body.category,
    title: req.body.title,
    issueDate: req.body.issueDate || '',
    expiryDate: req.body.expiryDate || '',
    status: req.body.status || 'Stored',
    fileName: req.file ? req.file.filename : '',
    notes: req.body.notes || '',
    uploadedBy: user.id,
    uploadedAt: new Date().toISOString()
  };

  db.documents.push(d);
  audit(db, 'Uploaded document ' + d.title, user);
  write(db);

  res.json(d);
});

app.get('/api/download/:file', auth, (req, res) => {
  res.download(path.join(uploadDir, req.params.file));
});
/* DOCUMENT CONTROL */

app.put('/api/documents/:id', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  const doc = db.documents.find(d => d.id === req.params.id);

  if (!doc) {
    return res.status(404).json({ error: 'Document not found' });
  }

  const property = db.properties.find(p => p.id === doc.propertyId);

  if (!property || !propertyAccess(user, property)) {
    return res.status(403).json({ error: 'No access' });
  }

  doc.category = req.body.category || doc.category;
  doc.title = req.body.title || doc.title;
  doc.issueDate = req.body.issueDate || '';
  doc.expiryDate = req.body.expiryDate || '';
  doc.status = req.body.expiryDate ? 'Valid' : 'Stored';
  doc.notes = req.body.notes || '';
  doc.updatedAt = new Date().toISOString();
  doc.updatedBy = user.id;

  audit(db, 'Updated document ' + doc.title, user);
  write(db);

  res.json({
    success: true,
    document: doc
  });
});

app.delete('/api/documents/:id', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  const docIndex = db.documents.findIndex(d => d.id === req.params.id);

  if (docIndex === -1) {
    return res.status(404).json({ error: 'Document not found' });
  }

  const doc = db.documents[docIndex];
  const property = db.properties.find(p => p.id === doc.propertyId);

  if (!property || !propertyAccess(user, property)) {
    return res.status(403).json({ error: 'No access' });
  }

  db.documents.splice(docIndex, 1);

  audit(db, 'Deleted document ' + doc.title, user);
  write(db);

  res.json({
    success: true
  });
});
/* CONTRACTORS */

app.post('/api/contractors', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  const c = {
    id: uuid(),
    trade: req.body.trade,
    company: req.body.company,
    contactName: req.body.contactName || '',
    email: req.body.email || '',
    phone: req.body.phone || '',
    accreditation: req.body.accreditation || '',
    approved: req.body.approved !== false
  };

  db.contractors.push(c);
  audit(db, 'Added approved contractor ' + c.company, user);
  write(db);

  res.json(c);
});

/* CONTRACTOR UPLOAD LINKS */

app.post('/api/links/contractor', auth, (req, res) => {
  const db = read();
  db.links = db.links || [];

  const user = currentUser(req);
  const p = db.properties.find(x => x.id === req.body.propertyId);

  if (!p || !propertyAccess(user, p)) {
    return res.status(403).json({ error: 'No access' });
  }

  const token = uuid();

  db.links.push({
    id: uuid(),
    token,
    type: 'contractor_upload',
    propertyId: p.id,
    createdBy: user.id,
    createdAt: new Date().toISOString(),
    active: true
  });

  audit(db, 'Created contractor upload link for ' + p.address, user);
  write(db);

  res.json({
    url: '/contractor-upload/' + token,
    token
  });
});

app.get('/contractor-upload/:token', (req, res) => {
  const db = read();
  const link = findLink(db, req.params.token, 'contractor_upload');

  if (!link) {
    return res.status(404).send(publicLayout('Link expired', '<p>This upload link is not valid.</p>'));
  }

  const p = db.properties.find(x => x.id === link.propertyId);

  res.send(publicLayout('Contractor Document Upload', `
    <p><b>Property:</b> ${p?.address || ''}</p>
    <form method="post" enctype="multipart/form-data">
      <div class="field">
        <label>Compliance type</label>
        <select name="category">
          <option>Gas Safety</option>
          <option>Electrical</option>
          <option>EICR</option>
          <option>PAT Testing</option>
          <option>EPC</option>
          <option>Legionella</option>
          <option>Smoke & CO Alarms</option>
          <option>Fire Safety</option>
        </select>
      </div>
      <div class="field">
        <label>Document title</label>
        <input name="title" required placeholder="e.g. Gas Safety Certificate">
      </div>
      <div class="field">
        <label>Issue date</label>
<input type="date" name="issueDate" required>
      </div>
      <div class="field">
        <label>Expiry date</label>
<input type="date" name="expiryDate" required>
      </div>
      <div class="field">
        <label>Upload PDF/photo</label>
        <input type="file" name="file" required>
      </div>
      <div class="field">
        <label>Notes</label>
        <textarea name="notes"></textarea>
      </div>
      <button>Upload completed document</button>
    </form>
  `));
});

app.post('/contractor-upload/:token', upload.single('file'), (req, res) => {
  const db = read();
  const link = findLink(db, req.params.token, 'contractor_upload');

  if (!link) {
    return res.status(404).send(publicLayout('Link expired', '<p>This upload link is not valid.</p>'));
  }

  const p = db.properties.find(x => x.id === link.propertyId);
if (!req.body.issueDate || !req.body.expiryDate || !req.file) {
  return res.status(400).send(
    publicLayout(
      'Upload incomplete',
      '<p>Issue date, expiry date and certificate upload are required before submitting.</p>'
    )
  );
}
  const d = {
    id: uuid(),
    propertyId: p.id,
    category: req.body.category,
    title: req.body.title,
    issueDate: req.body.issueDate || '',
    expiryDate: req.body.expiryDate || '',
    status: req.body.expiryDate ? 'Valid' : 'Stored',
    fileName: req.file ? req.file.filename : '',
    notes: req.body.notes || 'Uploaded by contractor link',
    uploadedBy: 'contractor-link',
    uploadedAt: new Date().toISOString()
  };

  db.documents.push(d);
  audit(db, 'Contractor uploaded document ' + d.title, { email: 'contractor-link' });
  write(db);

  res.send(publicLayout('Upload received', '<p>Thank you. The compliance document has been uploaded to the landlord account.</p>'));
});

/* CONTRACTOR JOB REQUESTS */

app.post('/api/contractor-jobs', auth, (req, res) => {
  const db = read();
  db.contractorJobs = db.contractorJobs || [];

  const user = currentUser(req);
  const property = db.properties.find(p => p.id === req.body.propertyId);

  if (!property || !propertyAccess(user, property)) {
    return res.status(403).json({ error: 'No access to property' });
  }

  const token = uuid();

  const job = {
    id: uuid(),
    token,
    propertyId: property.id,
    propertyAddress: property.address,
    contractorId: req.body.contractorId || '',
    contractorName: req.body.contractorName || '',
    contractorEmail: req.body.contractorEmail || '',
    complianceType: req.body.complianceType || 'Gas Safety',
    landlordName: req.body.landlordName || user.name,
    landlordEmail: req.body.landlordEmail || user.email,
    landlordPhone: req.body.landlordPhone || '',
    landlordCompany: req.body.landlordCompany || '',
    message: req.body.message || '',
    status: 'Requested',
    quotedPrice: '',
    bookedDate: '',
    bookedTime: '',
    contractorNotes: '',
    createdBy: user.id,
    createdAt: new Date().toISOString(),
    updatedAt: ''
  };

  db.contractorJobs.unshift(job);
  audit(db, 'Created contractor job request for ' + property.address, user);
  write(db);

  res.json({
    success: true,
    job,
    contractorLink: `${req.protocol}://${req.get('host')}/contractor-job/${token}`
  });
});

app.get('/api/contractor-jobs', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  const properties = db.properties.filter(p => propertyAccess(user, p));
  const propertyIds = properties.map(p => p.id);

  const jobs = (db.contractorJobs || []).filter(j =>
    user.role === 'administrator' || propertyIds.includes(j.propertyId)
  );

  res.json(jobs);
});

app.get('/contractor-job/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'contractor-job.html'));
});

app.get('/api/contractor-job/:token', (req, res) => {
  const db = read();

  const job = (db.contractorJobs || []).find(j => j.token === req.params.token);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json(job);
});

app.post('/api/contractor-job/:token/update', upload.single('certificate'), (req, res) => {
  const db = read();

  const job = (db.contractorJobs || []).find(j => j.token === req.params.token);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const newStatus = req.body.status || job.status;

  if (newStatus === 'Completed' && req.file) {
    if (!req.body.issueDate || !req.body.expiryDate) {
      return res.status(400).json({
        error: 'Issue date and expiry date are required when uploading a completed certificate.'
      });
    }
  }

  job.status = newStatus;
  job.quotedPrice = req.body.quotedPrice || job.quotedPrice;
  job.bookedDate = req.body.bookedDate || job.bookedDate;
  job.bookedTime = req.body.bookedTime || job.bookedTime;
  job.contractorNotes = req.body.contractorNotes || job.contractorNotes;
  job.updatedAt = new Date().toISOString();

  if (req.file && job.status === 'Completed') {
    const document = {
      id: uuid(),
      propertyId: job.propertyId,
      category: job.complianceType || 'Gas Safety',
      title: `${job.complianceType || 'Compliance'} Certificate`,
      issueDate: req.body.issueDate,
      expiryDate: req.body.expiryDate,
      status: 'Valid',
      fileName: req.file.filename,
      notes: req.body.certificateNotes || 'Uploaded by contractor on job completion',
      uploadedBy: 'contractor-job-link',
      uploadedAt: new Date().toISOString()
    };

    db.documents.push(document);

    job.completedCertificateId = document.id;
    job.completedCertificateFile = req.file.filename;
  }

  audit(db, 'Contractor updated job for ' + job.propertyAddress, { email: 'contractor-link' });
  write(db);

  res.json({
    success: true,
    job
  });
});

/* PROPERTY CONDITION REVIEWS */

app.post('/api/reviews', auth, upload.array('photos', 20), (req, res) => {
  const db = read();
  const user = currentUser(req);

  const p = db.properties.find(x => x.id === req.body.propertyId);

  if (!p || !propertyAccess(user, p)) {
    return res.status(403).json({ error: 'No access' });
  }

  const r = {
    id: uuid(),
    propertyId: p.id,
    date: req.body.date,
    completedBy: req.body.completedBy || user.name,
    outcome: req.body.outcome || 'Good Condition',
    notes: req.body.notes || '',
    photos: (req.files || []).map(f => f.filename)
  };

  db.reviews.unshift(r);
  p.lastConditionReview = req.body.date;
  p.nextConditionReview = req.body.nextDate || p.nextConditionReview;

  audit(db, 'Added Property Condition Review for ' + p.address, user);
  write(db);

  res.json(r);
});

/* TENANT MAINTENANCE */

app.post('/api/links/tenant-maintenance', auth, (req, res) => {
  const db = read();
  db.links = db.links || [];

  const user = currentUser(req);
  const p = db.properties.find(x => x.id === req.body.propertyId);

  if (!p || !propertyAccess(user, p)) {
    return res.status(403).json({ error: 'No access' });
  }

  const token = uuid();

  db.links.push({
    id: uuid(),
    token,
    type: 'tenant_maintenance',
    propertyId: p.id,
    createdBy: user.id,
    createdAt: new Date().toISOString(),
    active: true
  });

  audit(db, 'Created tenant maintenance link for ' + p.address, user);
  write(db);

  res.json({
    url: '/tenant-maintenance/' + token,
    token
  });
});

app.post('/api/maintenance', auth, upload.array('photos', 12), (req, res) => {
  const db = read();
  const user = currentUser(req);

  const m = {
    id: uuid(),
    propertyId: req.body.propertyId,
    title: req.body.title,
    priority: req.body.priority || 'Medium',
    status: 'Open',
    notes: req.body.notes || '',
    photos: (req.files || []).map(f => f.filename),
    reportedBy: user.id,
    createdAt: new Date().toISOString()
  };

  db.maintenance = db.maintenance || [];
  db.maintenance.unshift(m);

  audit(db, 'Maintenance report: ' + m.title, user);
  write(db);

  res.json(m);
});

app.get('/tenant-maintenance/:token', (req, res) => {
  const db = read();
  const link = findLink(db, req.params.token, 'tenant_maintenance');

  if (!link) {
    return res.status(404).send(publicLayout('Link expired', '<p>This maintenance link is not valid.</p>'));
  }

  const p = db.properties.find(x => x.id === link.propertyId);

  res.send(publicLayout('Tenant Maintenance Report', `
    <p><b>Property:</b> ${p?.address || ''}</p>
    <form method="post" enctype="multipart/form-data">
      <div class="field">
        <label>Problem title</label>
        <input name="title" required placeholder="e.g. Leak under kitchen sink">
      </div>
      <div class="field">
        <label>Priority</label>
        <select name="priority">
          <option>Low</option>
          <option>Medium</option>
          <option>High</option>
          <option>Urgent</option>
        </select>
      </div>
      <div class="field">
        <label>Description of problem</label>
        <textarea name="notes" required></textarea>
      </div>
      <div class="field">
        <label>Upload images</label>
        <input type="file" name="photos" multiple accept="image/*">
      </div>
      <button>Submit maintenance report</button>
    </form>
  `));
});

app.post('/tenant-maintenance/:token', upload.array('photos', 12), (req, res) => {
  const db = read();
  const link = findLink(db, req.params.token, 'tenant_maintenance');

  if (!link) {
    return res.status(404).send(publicLayout('Link expired', '<p>This maintenance link is not valid.</p>'));
  }

  const m = {
    id: uuid(),
    propertyId: link.propertyId,
    title: req.body.title,
    priority: req.body.priority || 'Medium',
    status: 'Open',
    notes: req.body.notes || '',
    photos: (req.files || []).map(f => f.filename),
    reportedBy: 'tenant-link',
    createdAt: new Date().toISOString()
  };

  db.maintenance = db.maintenance || [];
  db.maintenance.unshift(m);

  audit(db, 'Tenant maintenance report: ' + m.title, { email: 'tenant-link' });
  write(db);

  res.send(publicLayout('Report submitted', `
    <p>Your maintenance report has been sent to the landlord.</p>
    <p>Reference: ${m.id}</p>
  `));
});

app.get('/api/maintenance/:id/pdf', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  const m = (db.maintenance || []).find(x => x.id === req.params.id);

  if (!m) return res.status(404).send('Not found');

  const p = db.properties.find(x => x.id === m.propertyId);

  if (!p || !propertyAccess(user, p)) {
    return res.status(403).send('No access');
  }

  const doc = new PDFDocument({ margin: 50 });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="maintenance-${m.id}.pdf"`);

  doc.pipe(res);

  doc.fontSize(20).text('Maintenance Report', { underline: true });
  doc.moveDown();
  doc.fontSize(12).text(`Property: ${p.address}`);
  doc.text(`Issue: ${m.title}`);
  doc.text(`Priority: ${m.priority}`);
  doc.text(`Status: ${m.status}`);
  doc.text(`Reported: ${new Date(m.createdAt).toLocaleString('en-GB')}`);
  doc.moveDown();
  doc.fontSize(14).text('Description');
  doc.fontSize(12).text(m.notes || 'No description provided.');
  doc.moveDown();
  doc.fontSize(14).text('Uploaded Images');

  if ((m.photos || []).length === 0) {
    doc.fontSize(12).text('No images uploaded.');
  }

  (m.photos || []).forEach((ph, i) => {
    doc.fontSize(12).text(`${i + 1}. ${ph}`);
  });

  doc.moveDown();
  doc.text('Use this PDF to send the job details to an approved contractor.');
  doc.end();
});

/* PREMIUM PLACEHOLDER */

app.post('/api/premium/ocr', auth, (req, res) => {
  res.json({
    feature: 'OCR extraction',
    status: 'Premium placeholder',
    message: 'This endpoint is ready to connect to OCR such as Google Vision, AWS Textract, Azure Document Intelligence, or OpenAI Vision.'
  });
});

/* REMINDERS */

function dueDocs() {
  const db = read();
  const days = db.settings?.reminderDays || [90, 60, 30, 7, 1];
  const today = new Date();

  return db.documents
    .filter(d => d.expiryDate)
    .map(d => {
      const diff = Math.ceil((new Date(d.expiryDate) - today) / 86400000);
      return { ...d, daysLeft: diff };
    })
    .filter(d => days.includes(d.daysLeft) || d.daysLeft < 0);
}

app.post('/api/reminders/run', auth, async (req, res) => {
  const user = currentUser(req);

  if (user.role !== 'administrator') {
    return res.status(403).json({ error: 'Admin only' });
  }

  const due = dueDocs();
  const db = read();

  due.forEach(d =>
    db.reminders.unshift({
      id: uuid(),
      at: new Date().toISOString(),
      documentId: d.id,
      message: `${d.category} for property expires in ${d.daysLeft} days`
    })
  );

  audit(db, 'Manual reminder run: ' + due.length + ' reminders', user);
  write(db);

  res.json({
    sentOrLogged: due.length,
    reminders: due
  });
});

cron.schedule('0 8 * * *', () => {
  try {
    const due = dueDocs();

    if (due.length) {
      const db = read();

      due.forEach(d =>
        db.reminders.unshift({
          id: uuid(),
          at: new Date().toISOString(),
          documentId: d.id,
          message: `${d.category} expires in ${d.daysLeft} days`
        })
      );

      write(db);
    }
  } catch (e) {
    console.error(e);
  }
});
/* ADMIN CONTROL CENTRE */

function adminOnly(req, res, next) {
  const user = currentUser(req);

  if (!user || user.role !== 'administrator') {
    return res.status(403).json({ error: 'Admin only' });
  }

  next();
}
app.post('/api/admin/users', auth, adminOnly, (req, res) => {
  const db = read();
  db.users = db.users || [];

  const admin = currentUser(req);

  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const role = req.body.role || 'landlord';

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are required' });
  }

  if (!['landlord', 'letting_agent', 'contractor', 'tenant', 'administrator'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const existing = db.users.find(u => u.email.toLowerCase() === email);

  if (existing) {
    return res.status(400).json({ error: 'A user with this email already exists' });
  }

  const user = {
    id: uuid(),
    name,
    email,
    role,
    passwordHash: bcrypt.hashSync(password, 10),
    createdByAdmin: admin.id,
    createdAt: new Date().toISOString()
  };

  db.users.push(user);

  audit(db, 'Admin created user ' + email, admin);
  write(db);

  res.json({
    success: true,
    user: safeUser(user)
  });
});
app.get('/api/admin-control', auth, adminOnly, (req, res) => {
  const db = read();

  res.json({
    users: (db.users || []).map(safeUser),
    landlords: (db.users || []).filter(u => u.role === 'landlord').map(safeUser),
    agents: (db.users || []).filter(u => u.role === 'letting_agent').map(safeUser),
    contractors: db.contractors || [],
    tenants: (db.users || []).filter(u => u.role === 'tenant').map(safeUser),
    properties: db.properties || [],
    documents: db.documents || [],
    contractorJobs: db.contractorJobs || [],
    maintenance: db.maintenance || [],
    audit: db.audit || []
  });
});

app.get('/api/admin-user/:id', auth, adminOnly, (req, res) => {
  const db = read();

  const user = (db.users || []).find(u => u.id === req.params.id);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const properties = (db.properties || []).filter(p =>
    p.landlordId === user.id ||
    p.agentId === user.id ||
    (p.tenantIds || []).includes(user.id)
  );

  const propertyIds = properties.map(p => p.id);

  res.json({
    user: safeUser(user),
    properties,
    documents: (db.documents || []).filter(d => propertyIds.includes(d.propertyId)),
    contractorJobs: (db.contractorJobs || []).filter(j => propertyIds.includes(j.propertyId)),
    maintenance: (db.maintenance || []).filter(m => propertyIds.includes(m.propertyId))
  });
});
/* ADMIN ANALYTICS */

app.get('/api/admin-analytics', (req, res) => {
  const db = read();

  const now = new Date();
  const docs = db.documents || [];

  const expired = docs.filter(d =>
    d.expiryDate && new Date(d.expiryDate) < now
  );

  const dueSoon = docs.filter(d => {
    if (!d.expiryDate) return false;

    const days = Math.ceil(
      (new Date(d.expiryDate) - now) / 86400000
    );

    return days >= 0 && days <= 60;
  });

  res.json({
    users: (db.users || []).length,
    landlords: (db.users || []).filter(u => u.role === 'landlord').length,
    agents: (db.users || []).filter(u => u.role === 'letting_agent').length,
    contractors: (db.contractors || []).length,
    tenants: (db.users || []).filter(u => u.role === 'tenant').length,
    properties: (db.properties || []).length,
    documents: docs.length,
    expired: expired.length,
    dueSoon: dueSoon.length,
    maintenanceOpen: (db.maintenance || []).filter(
      m => m.status !== 'Completed'
    ).length,
    contractorJobs: (db.contractorJobs || []).length,
    bookedJobs: (db.contractorJobs || []).filter(
      j => j.status === 'Booked In'
    ).length
  });
});
/* FRONTEND FALLBACK */

 app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

/* START SERVER */

app.listen(PORT, () => {
  console.log(`Landlord Compliance Hub running on http://localhost:${PORT}`);
});
