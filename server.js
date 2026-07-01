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
app.use(express.static(path.join(__dirname, 'public'), {
  index: false
}));
app.use('/images', express.static(path.join(__dirname, 'public', 'public', 'images')));

function safeUser(u) {
  return u && {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    disabled: !!u.disabled,

    tenantId: u.tenantId || '',
    propertyId: u.propertyId || '',
    linkedPropertyAddress: u.linkedPropertyAddress || '',

    accountId: u.accountId || u.id,
    accountType: u.accountType || 'landlord',

    permissionLevel:
      u.permissionLevel ||
      (u.role === 'administrator'
        ? 'platform_admin'
        : 'account_owner'),

    plan: u.plan || 'starter',
    propertyLimit: u.propertyLimit || 5,
    adminUserLimit: u.adminUserLimit || 1
  };
}

function auth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function currentUser(req) {
  const db = read();

  const user = db.users.find(
    u => u.id === req.session.userId
  );

  if (!user) return null;

  user.accountId = user.accountId || user.id;
  user.accountType = user.accountType || 'landlord';

  user.permissionLevel =
    user.permissionLevel ||
    (user.role === 'administrator'
      ? 'platform_admin'
      : 'account_owner');

  user.plan = user.plan || 'starter';
  user.propertyLimit = user.propertyLimit || 5;
  user.adminUserLimit = user.adminUserLimit || 1;

  return user;
}

function getAccountId(user) {
  return user?.accountId || user?.id;
}

function isPlatformAdmin(user) {
  return user?.role === 'administrator' || user?.permissionLevel === 'platform_admin';
}

function isAccountAdmin(user) {
  return (
    user?.permissionLevel === 'account_owner' ||
    user?.permissionLevel === 'account_admin'
  );
}

function canManageDocuments(user) {
  return isPlatformAdmin(user) || isAccountAdmin(user);
}

function canModifyPropertyData(user) {
  return user && ['landlord', 'letting_agent', 'administrator'].includes(user.role);
}

function propertyAccess(user, p) {
  if (!user || !p) return false;

  if (isPlatformAdmin(user)) return true;

  if (user.role === 'landlord') {
    return p.landlordId === user.id;
  }

  if (user.role === 'letting_agent') {
    return p.agentId === user.id;
  }

if (user.role === 'tenant') {
  return (
    p.id === user.propertyId ||
    (p.tenantIds || []).includes(user.tenantId) ||
    (p.tenantIds || []).includes(user.id)
  );
}

  if (user.role === 'contractor') {
    return false;
  }

  return false;
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
  const db = read();

  const user = (db.users || []).find(
    u => (u.email || '').toLowerCase() === (req.body.email || '').toLowerCase()
  );

  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const passwordOk =
    user.password === req.body.password ||
    (user.passwordHash && bcrypt.compareSync(req.body.password || '', user.passwordHash));

  if (!passwordOk) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (user.disabled) {
    return res.status(403).json({
      error: 'This account has been disabled. Please contact support.'
    });
  }

  req.session.userId = user.id;

  res.json({
    success: true,
    user: safeUser(user)
  });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  res.json({ user: safeUser(currentUser(req)) });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});
/* MAIN APP DATA */

app.get('/api/app', auth, (req, res) => {
  const db = read();

  db.links = db.links || [];
  db.contractorJobs = db.contractorJobs || [];
  db.documents = db.documents || [];
  db.properties = db.properties || [];
  db.reviews = db.reviews || [];
  db.maintenance = db.maintenance || [];
  db.contractors = db.contractors || [];
  db.reminders = db.reminders || [];
  db.audit = db.audit || [];

  const user = currentUser(req);

  if (!user) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const accountId = getAccountId(user);

  if (user.role === 'contractor') {
    const contractorJobs = db.contractorJobs.filter(j =>
      j.contractorId === user.id ||
      (j.contractorEmail || '').toLowerCase() === (user.email || '').toLowerCase()
    );

    const contractorJobIds = contractorJobs.map(j => j.id);
    const uploadedDocumentIds = contractorJobs.map(j => j.completedCertificateId).filter(Boolean);
    const uploadedFileNames = contractorJobs.map(j => j.completedCertificateFile).filter(Boolean);

    return res.json({
      user: safeUser(user),
      users: [],
      properties: [],
      contractors: [],
      contractorJobs,
      documents: db.documents.filter(d =>
        uploadedDocumentIds.includes(d.id) ||
        uploadedFileNames.includes(d.fileName) ||
        contractorJobIds.includes(d.contractorJobId)
      ),
      reviews: [],
      maintenance: [],
      reminders: [],
      audit: []
    });
  }

  const properties = db.properties.filter(p => propertyAccess(user, p));
  const propertyIds = properties.map(p => p.id);

  const contractors = isPlatformAdmin(user)
    ? db.contractors
    : db.contractors.filter(c =>
        (c.landlordIds || []).includes(user.id)
      );

  res.json({
    user: safeUser(user),

    users: isPlatformAdmin(user)
      ? db.users.map(safeUser)
      : [],

    properties,

    documents: db.documents.filter(d =>
      propertyIds.includes(d.propertyId)
    ),

    contractors,

    contractorJobs: db.contractorJobs.filter(j =>
      isPlatformAdmin(user) ||
      propertyIds.includes(j.propertyId)
    ),

    reviews: db.reviews.filter(r =>
      propertyIds.includes(r.propertyId)
    ),

    maintenance: db.maintenance.filter(m =>
      propertyIds.includes(m.propertyId)
    ),

    reminders: isPlatformAdmin(user)
      ? db.reminders
      : [],
audit: isPlatformAdmin(user)
  ? db.audit.slice(0, 100)
  : [],

tenants: (db.tenants || []).filter(t =>
  isPlatformAdmin(user) ||
  t.landlordEmail === user.email ||
  propertyIds.includes(t.propertyId)
)
  });
});

/* PROPERTIES */

app.post('/api/properties', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);
  if (!canModifyPropertyData(user)) {
  return res.status(403).json({ error: 'Tenants cannot add properties' });
}

  const ownerId =
  user.role === 'administrator' && req.body.landlordId
    ? req.body.landlordId
    : user.id;

const p = {
  id: uuid(),

  accountId: getAccountId(user),

  ownerUserId: ownerId,

  address: req.body.address,
  type: req.body.type || '',

  landlordId: ownerId,

  agentId: req.body.agentId || '',

  tenantIds: [],

  shadowLandlordUserIds: [],

  status: 'Needs Review',

  lastConditionReview: '',

  nextConditionReview: ''
};

  db.properties.push(p);
  audit(db, 'Created property ' + p.address, user);
  write(db);

  res.json(p);
});
app.put('/api/properties/:id', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  const p = (db.properties || []).find(x => x.id === req.params.id);

  if (!p) {
    return res.status(404).json({ error: 'Property not found' });
  }

  if (!propertyAccess(user, p)) {
    return res.status(403).json({ error: 'No access' });
  }

  p.address = req.body.address || p.address;
  p.type = req.body.type || '';
  p.status = req.body.status || p.status || 'Needs Review';
  p.updatedAt = new Date().toISOString();
  p.updatedBy = user.id;

  audit(db, 'Updated property ' + p.address, user);
  write(db);

  res.json({ success: true, property: p });
});

app.delete('/api/properties/:id', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  const index = (db.properties || []).findIndex(x => x.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: 'Property not found' });
  }

  const p = db.properties[index];

  if (!propertyAccess(user, p)) {
    return res.status(403).json({ error: 'No access' });
  }

  db.properties.splice(index, 1);

  db.documents = (db.documents || []).filter(d => d.propertyId !== p.id);
  db.reviews = (db.reviews || []).filter(r => r.propertyId !== p.id);
  db.maintenance = (db.maintenance || []).filter(m => m.propertyId !== p.id);
  db.contractorJobs = (db.contractorJobs || []).filter(j => j.propertyId !== p.id);

  audit(db, 'Deleted property ' + p.address, user);
  write(db);

  res.json({ success: true });
});
/* DOCUMENTS */

app.post('/api/documents', auth, upload.single('file'), (req, res) => {
  const db = read();
  const user = currentUser(req);

  db.documents = db.documents || [];
  db.properties = db.properties || [];

  if (!canModifyPropertyData(user)) {
    return res.status(403).json({ error: 'Tenants cannot upload compliance documents' });
  }

  const p = db.properties.find(x => x.id === req.body.propertyId);

  if (!p || !propertyAccess(user, p)) {
    return res.status(403).json({ error: 'No access' });
  }

  const d = {
    id: uuid(),
    propertyId: p.id,
    category: req.body.category || 'Stored',
    title: req.body.title || 'Uploaded Document',
    issueDate: req.body.issueDate || '',
    expiryDate: req.body.expiryDate || '',
    status: req.body.expiryDate ? 'Valid' : 'Stored',
    fileName: req.file ? req.file.filename : '',
    notes: req.body.notes || '',
    uploadedBy: user.id,
    uploadedAt: new Date().toISOString()
  };

  db.documents.unshift(d);

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

  const accountId = getAccountId(user);

const c = {
  id: uuid(),

  accountId,
  accountIds: [accountId],

  trade: req.body.trade || '',
  company: req.body.company || '',
  contactName: req.body.contactName || '',
  email: req.body.email || '',
  phone: req.body.phone || '',
  accreditation: req.body.accreditation || '',

  landlordIds: Array.isArray(req.body.landlordIds)
    ? req.body.landlordIds
    : [user.id],

  approved: req.body.approved !== false,
  createdAt: new Date().toISOString(),
  createdBy: user.id
};

  db.contractors = db.contractors || [];
  db.contractors.push(c);

  audit(db, 'Added contractor ' + c.company, user);
  write(db);

  res.json(c);
});

app.put('/api/contractors/:id', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  if (user.role !== 'administrator') {
    return res.status(403).json({ error: 'Admin only' });
  }

  const c = (db.contractors || []).find(x => x.id === req.params.id);

  if (!c) {
    return res.status(404).json({ error: 'Contractor not found' });
  }

  c.company = req.body.company || c.company;
  c.trade = req.body.trade || '';
  c.contactName = req.body.contactName || '';
  c.email = req.body.email || '';
  c.phone = req.body.phone || '';
  c.accreditation = req.body.accreditation || '';
  c.landlordIds = Array.isArray(req.body.landlordIds) ? req.body.landlordIds : [];
  c.approved = req.body.approved === 'true' || req.body.approved === true;
  c.updatedAt = new Date().toISOString();
  c.updatedBy = user.id;

  audit(db, 'Updated contractor ' + c.company, user);
  write(db);

  res.json({ success: true, contractor: c });
});

app.delete('/api/contractors/:id', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  if (user.role !== 'administrator') {
    return res.status(403).json({ error: 'Admin only' });
  }

  const index = (db.contractors || []).findIndex(x => x.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: 'Contractor not found' });
  }

  const c = db.contractors[index];

  db.contractors.splice(index, 1);

  audit(db, 'Deleted contractor ' + c.company, user);
  write(db);

  res.json({ success: true });
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

    accountId: property.accountId || getAccountId(user),

    propertyId: property.id,
    propertyAddress: property.address,

    contractorId: req.body.contractorId || '',
    contractorName: req.body.contractorName || '',
    contractorEmail: req.body.contractorEmail || '',

    complianceType: req.body.complianceType || 'Gas Safety',

    maintenanceId: req.body.maintenanceId || '',
    maintenanceTitle: req.body.maintenanceTitle || '',
    maintenancePriority: req.body.maintenancePriority || '',
    maintenanceReportUrl: req.body.maintenanceReportUrl || '',

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

app.put('/api/contractor-jobs/:id', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  const job = (db.contractorJobs || []).find(j => j.id === req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'Contractor job not found' });
  }

  const property = (db.properties || []).find(p => p.id === job.propertyId);

  if (!property || !propertyAccess(user, property)) {
    return res.status(403).json({ error: 'No access' });
  }

  job.complianceType = req.body.complianceType || job.complianceType;
  job.contractorId = req.body.contractorId || '';
  job.contractorName = req.body.contractorName || '';
  job.contractorEmail = req.body.contractorEmail || '';
  job.status = req.body.status || job.status;
  job.quotedPrice = req.body.quotedPrice || '';
  job.bookedDate = req.body.bookedDate || '';
  job.bookedTime = req.body.bookedTime || '';
  job.contractorNotes = req.body.contractorNotes || '';
  job.updatedAt = new Date().toISOString();
  job.updatedBy = user.id;

  audit(db, 'Updated contractor job for ' + job.propertyAddress, user);
  write(db);

  res.json({ success: true, job });
});

app.delete('/api/contractor-jobs/:id', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  const index = (db.contractorJobs || []).findIndex(j => j.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: 'Contractor job not found' });
  }

  const job = db.contractorJobs[index];
  const property = (db.properties || []).find(p => p.id === job.propertyId);

  if (!property || !propertyAccess(user, property)) {
    return res.status(403).json({ error: 'No access' });
  }

  db.contractorJobs.splice(index, 1);

  audit(db, 'Deleted contractor job for ' + job.propertyAddress, user);
  write(db);

  res.json({ success: true });
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

  const oldStatus = job.status;
  const newStatus = req.body.status || job.status;
  const now = new Date();

  if ((newStatus === 'Booked In' || newStatus === 'Completed') && job.quoteStatus !== 'Accepted') {
    return res.status(403).json({
      error: 'The landlord must accept the quote before this job can be booked or completed.'
    });
  }

  job.status = newStatus;
  job.quotedPrice = req.body.quotedPrice || job.quotedPrice;
  job.bookedDate = req.body.bookedDate || job.bookedDate;
  job.bookedTime = req.body.bookedTime || job.bookedTime;
  job.contractorNotes = req.body.contractorNotes || job.contractorNotes;
  job.updatedAt = now.toISOString();

  if (newStatus === 'Quote Sent') {
    job.quoteStatus = 'Pending';
    job.quoteSentAt = job.quoteSentAt || now.toISOString();
    job.contractorNotification = 'Quote sent to landlord. Awaiting approval.';
  }

  if (newStatus === 'Booked In' && oldStatus !== 'Booked In') {
    job.bookedInAt = now.toISOString();
  }

  if (newStatus === 'Completed' && oldStatus !== 'Completed') {
    job.completedAt = now.toISOString();
  }

  if (newStatus === 'Completed' && req.file) {
    if (!req.body.issueDate || !req.body.expiryDate) {
      return res.status(400).json({
        error: 'Issue date and expiry date are required when uploading completion evidence.'
      });
    }

    db.documents = db.documents || [];

    const document = {
      id: uuid(),
      propertyId: job.propertyId,
      category: job.complianceType || 'Maintenance',
      title: `${job.complianceType || 'Maintenance'} Completion Evidence`,
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

  res.json({ success: true, job });
});
app.post('/api/contractor-job/:token/slots', (req, res) => {
  const db = read();

  db.contractorJobs = db.contractorJobs || [];

  const job = db.contractorJobs.find(j => j.token === req.params.token);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const slots = req.body.appointmentSlots || [];
  const slotsExpiryDate = req.body.slotsExpiryDate || '';
  const slotsExpiryTime = req.body.slotsExpiryTime || '';

  if (!Array.isArray(slots) || slots.length === 0) {
    return res.status(400).json({ error: 'At least one appointment slot is required.' });
  }

  if (slots.length > 5) {
    return res.status(400).json({ error: 'Maximum of 5 appointment slots allowed.' });
  }

  if (!slotsExpiryDate || !slotsExpiryTime) {
    return res.status(400).json({
      error: 'Tenant response deadline date and time are required.'
    });
  }

  const expiryAt = new Date(`${slotsExpiryDate}T${slotsExpiryTime}`);

  if (isNaN(expiryAt.getTime())) {
    return res.status(400).json({
      error: 'Invalid tenant response deadline.'
    });
  }

  if (expiryAt <= new Date()) {
    return res.status(400).json({
      error: 'Tenant response deadline must be in the future.'
    });
  }

  job.appointmentSlots = slots.map((slot, index) => ({
    id: slot.id || uuid(),
    slotNumber: index + 1,
    date: slot.date || '',
    type: slot.type || '',
    startTime: slot.startTime || '',
    endTime: slot.endTime || '',
    status: 'Proposed',
    proposedBy: 'contractor',
    proposedAt: new Date().toISOString()
  }));

  job.slotsExpiryDate = slotsExpiryDate;
  job.slotsExpiryTime = slotsExpiryTime;
  job.slotsExpiryAt = expiryAt.toISOString();

  job.bookingStatus = 'Slots Proposed';
  job.contractorNotification = 'Appointment slots sent. Awaiting tenant or landlord selection before the deadline.';
  job.updatedAt = new Date().toISOString();

  audit(db, 'Contractor proposed appointment slots for ' + job.propertyAddress, { email: 'contractor-link' });
  write(db);

  res.json({
    success: true,
    job
  });
});
app.post('/api/contractor-jobs/:id/quote-decision', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  db.contractorJobs = db.contractorJobs || [];

  const job = db.contractorJobs.find(j => j.id === req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'Contractor job not found' });
  }

  const property = (db.properties || []).find(p => p.id === job.propertyId);

  if (!property || !propertyAccess(user, property)) {
    return res.status(403).json({ error: 'No access to this contractor job' });
  }

  const decision = req.body.decision;

  if (!['Accepted', 'Rejected'].includes(decision)) {
    return res.status(400).json({ error: 'Decision must be Accepted or Rejected' });
  }

  job.quoteStatus = decision;
  job.quoteDecisionAt = new Date().toISOString();
  job.quoteDecisionBy = user.email;
  job.quoteDecisionNotes = req.body.notes || '';

  if (decision === 'Accepted') {
    job.contractorNotification = 'Quote accepted by landlord. You can now arrange booking.';
  }

  if (decision === 'Rejected') {
    job.contractorNotification = 'Quote rejected by landlord. Please revise the quote or contact the landlord.';
  }

  audit(db, `${decision} contractor quote for ${job.propertyAddress}`, user);
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
app.put('/api/reviews/:id', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  const review = (db.reviews || []).find(r => r.id === req.params.id);

  if (!review) {
    return res.status(404).json({ error: 'Review not found' });
  }

  const property = db.properties.find(p => p.id === review.propertyId);

  if (!property || !propertyAccess(user, property)) {
    return res.status(403).json({ error: 'No access' });
  }

  review.date = req.body.date || review.date;
  review.outcome = req.body.outcome || review.outcome;
  review.notes = req.body.notes || '';
  review.updatedAt = new Date().toISOString();
  review.updatedBy = user.id;

  property.lastConditionReview = review.date;

  audit(db, 'Updated property condition review for ' + property.address, user);
  write(db);

  res.json({
    success: true,
    review
  });
});

app.delete('/api/reviews/:id', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  const reviewIndex = (db.reviews || []).findIndex(r => r.id === req.params.id);

  if (reviewIndex === -1) {
    return res.status(404).json({ error: 'Review not found' });
  }

  const review = db.reviews[reviewIndex];
  const property = db.properties.find(p => p.id === review.propertyId);

  if (!property || !propertyAccess(user, property)) {
    return res.status(403).json({ error: 'No access' });
  }

  db.reviews.splice(reviewIndex, 1);

  audit(db, 'Deleted property condition review for ' + property.address, user);
  write(db);

  res.json({
    success: true
  });
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
app.get('/tenant-maintenance/:token', (req, res) => {
  const db = read();

  const link = (db.links || []).find(l =>
    l.token === req.params.token &&
    l.type === 'tenant_maintenance' &&
    l.active !== false
  );

  if (!link) {
    return res.status(404).send(publicLayout(
      'Link expired',
      '<p>This maintenance link is not valid.</p>'
    ));
  }

  const property = (db.properties || []).find(p => p.id === link.propertyId);

  if (!property) {
    return res.status(404).send(publicLayout(
      'Property not found',
      '<p>The linked property could not be found.</p>'
    ));
  }

  res.send(publicLayout('Tenant Maintenance Report', `
    <p><b>Property:</b> ${property.address}</p>

    <form method="post" enctype="multipart/form-data">
      <input type="hidden" name="propertyId" value="${property.id}">

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
app.put('/api/maintenance/:id', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  db.maintenance = db.maintenance || [];
  db.contractors = db.contractors || [];

  const item = db.maintenance.find(m => m.id === req.params.id);

  if (!item) {
    return res.status(404).json({ error: 'Maintenance report not found' });
  }

  const property = (db.properties || []).find(p => p.id === item.propertyId);

  if (!property || !propertyAccess(user, property)) {
    return res.status(403).json({ error: 'No access' });
  }

  item.title = req.body.title || item.title;
  item.priority = req.body.priority || item.priority;

  if (req.body.status) {
    item.status = req.body.status;
    item.workflowStage = req.body.status;

    if (req.body.status === 'Completed') {
      item.completedAt = item.completedAt || new Date().toISOString();
    }

    if (req.body.status === 'Closed') {
      item.closedAt = item.closedAt || new Date().toISOString();
    }
  }

  if (req.body.notes !== undefined) {
    item.notes = req.body.notes;
  }

  if (req.body.landlordNotes !== undefined) {
    item.landlordNotes = req.body.landlordNotes;
  }

  if (req.body.assignedContractorId !== undefined) {
    if (!req.body.assignedContractorId) {
      item.assignedContractorId = '';
      item.assignedContractorName = '';
      item.assignedContractorEmail = '';
    } else {
      const contractor = db.contractors.find(c => c.id === req.body.assignedContractorId);

      if (!contractor) {
        return res.status(404).json({ error: 'Contractor not found' });
      }

   item.assignedContractorId = contractor.id;
item.assignedContractorName = contractor.company || contractor.trade || contractor.contactName || contractor.name || contractor.email || '';
item.assignedContractorEmail = contractor.email || '';

item.contractorId = contractor.id;
item.contractorName = item.assignedContractorName;
item.contractorEmail = contractor.email || '';

      if (item.status === 'New' || item.status === 'Reported' || !item.status) {
        item.status = 'Assigned';
        item.workflowStage = 'Assigned';
      }

      item.assignedAt = new Date().toISOString();
    }
  }

  item.updatedAt = new Date().toISOString();
  item.updatedBy = user.id;

  audit(db, 'Updated maintenance report: ' + item.title, user);
  write(db);

  res.json({
    success: true,
    item
  });
});
app.post('/tenant-maintenance/:token', upload.array('photos', 12), (req, res) => {
  const db = read();
  const link = findLink(db, req.params.token, 'tenant_maintenance');

  if (!link) {
    return res.status(404).send(publicLayout('Link expired', '<p>This maintenance link is not valid.</p>'));
  }

  const property = (db.properties || []).find(p => p.id === link.propertyId);

  if (!property) {
    return res.status(404).send(publicLayout('Property not found', '<p>The linked property could not be found.</p>'));
  }

  const m = {
    id: uuid(),
    propertyId: property.id,
    accountId: property.accountId || '',
    propertyAddress: property.address,
    title: req.body.title || 'Tenant maintenance report',
    priority: req.body.priority || 'Medium',
    status: 'Reported',
    notes: req.body.notes || '',
    photos: (req.files || []).map(f => f.filename),
    reportedBy: 'tenant-link',
    createdAt: new Date().toISOString()
  };

  db.maintenance = db.maintenance || [];
  db.maintenance.unshift(m);

  audit(db, 'Tenant maintenance report submitted: ' + m.title, { email: 'tenant-link' });
  write(db);

  res.send(publicLayout('Report submitted', `
    <p>Your maintenance report has been sent to the landlord.</p>
    <p><b>Property:</b> ${property.address}</p>
    <p><b>Reference:</b> ${m.id}</p>
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
app.put('/api/admin/users/:id', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  if (user.role !== 'administrator') {
    return res.status(403).json({ error: 'Admin only' });
  }

  const target = (db.users || []).find(u => u.id === req.params.id);

  if (!target) {
    return res.status(404).json({ error: 'User not found' });
  }

  target.name = req.body.name || target.name;
  target.email = req.body.email || target.email;
  target.role = req.body.role || target.role;
  target.updatedAt = new Date().toISOString();
  target.updatedBy = user.id;

  audit(db, 'Updated user ' + target.email, user);
  write(db);

  res.json({ success: true, user: safeUser(target) });
});

app.post('/api/admin/users/:id/toggle-disabled', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  if (user.role !== 'administrator') {
    return res.status(403).json({ error: 'Admin only' });
  }

  const target = (db.users || []).find(u => u.id === req.params.id);

  if (!target) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (target.id === user.id) {
    return res.status(400).json({ error: 'You cannot disable your own admin account' });
  }

  target.disabled = !target.disabled;
  target.updatedAt = new Date().toISOString();
  target.updatedBy = user.id;

  audit(db, (target.disabled ? 'Disabled user ' : 'Enabled user ') + target.email, user);
  write(db);

  res.json({ success: true, user: safeUser(target) });
});

app.delete('/api/admin/users/:id', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  if (user.role !== 'administrator') {
    return res.status(403).json({ error: 'Admin only' });
  }

  const index = (db.users || []).findIndex(u => u.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: 'User not found' });
  }

  const target = db.users[index];

  if (target.id === user.id) {
    return res.status(400).json({ error: 'You cannot delete your own admin account' });
  }

  db.users.splice(index, 1);

  audit(db, 'Deleted user ' + target.email, user);
  write(db);

  res.json({ success: true });
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
app.get('/tenant-setup/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tenant-setup.html'));
});

app.get('/tenant-view/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tenant-view.html'));
});
app.get('/api/tenant-view/:token', (req, res) => {
  const db = read();

  const tenant = (db.tenants || []).find(t => t.tenantViewToken === req.params.token);

  if (!tenant) {
    return res.status(404).json({ error: 'Tenant view link not found' });
  }

  const property = (db.properties || []).find(p => p.id === tenant.propertyId);

  if (!property) {
    return res.status(404).json({ error: 'Property not found' });
  }

  const documents = (db.documents || []).filter(d => d.propertyId === tenant.propertyId);

  res.json({
    success: true,
    tenant: {
      name: tenant.name,
      certificateAccess: tenant.certificateAccess,
      maintenanceAccess: tenant.maintenanceAccess
    },
    property,
    documents
  });
});
app.post('/api/tenant-view/:token/maintenance', upload.array('photos', 12), (req, res) => {
  const db = read();

  const tenant = (db.tenants || []).find(t => t.tenantViewToken === req.params.token);

  if (!tenant) {
    return res.status(404).json({ error: 'Tenant view link not found' });
  }

  if (!tenant.maintenanceAccess) {
    return res.status(403).json({ error: 'Maintenance reporting is not enabled for this tenant.' });
  }

  const property = (db.properties || []).find(p => p.id === tenant.propertyId);

  if (!property) {
    return res.status(404).json({ error: 'Property not found' });
  }

  const report = {
    id: uuid(),
    propertyId: property.id,
    accountId: property.accountId || '',
    propertyAddress: property.address,
    tenantId: tenant.id,
    tenantName: tenant.name || '',
    tenantEmail: tenant.email || '',
    tenantPhone: tenant.phone || '',
    title: req.body.title || 'Tenant maintenance report',
    priority: req.body.priority || 'Medium',
    status: 'Reported',
    notes: req.body.notes || '',
    photos: (req.files || []).map(f => f.filename),
    reportedBy: 'tenant-compliance-link',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  db.maintenance = db.maintenance || [];
  db.maintenance.unshift(report);

  audit(db, 'Tenant maintenance report submitted for ' + property.address, {
    email: tenant.email || 'tenant-link'
  });

  write(db);

  res.json({
    success: true,
    report
  });
});
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

/* START SERVER */
// ===============================
// TENANT MANAGEMENT ROUTES
// ===============================

app.get('/api/tenants', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  db.tenants = db.tenants || [];

  const tenants = db.tenants.filter(t => {
    if (user.role === 'admin') return true;
    return t.landlordEmail === user.email;
  });

  res.json(tenants);
});

app.post('/api/tenants', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  db.tenants = db.tenants || [];

  const property = (db.properties || []).find(p => p.id === req.body.propertyId);

  if (!property || !propertyAccess(user, property)) {
    return res.status(403).json({ error: 'No access to this property' });
  }

  const setupToken = uuid();
  const viewToken = uuid();

  const tenant = {
    id: uuid(),

    propertyId: req.body.propertyId,
    propertyAddress: property.address || '',

    landlordId: user.id || '',
    landlordEmail: user.email,

    name: req.body.name || '',
    email: req.body.email || '',
    phone: req.body.phone || '',

    maintenanceAccess: req.body.maintenanceAccess === true || req.body.maintenanceAccess === 'true',
    certificateAccess: req.body.certificateAccess === true || req.body.certificateAccess === 'true',

    tenantToken: setupToken,
    tenantSetupToken: setupToken,
    tenantViewToken: viewToken,

    accountStatus: 'Invite Sent',
    verifiedEmail: false,
    verifiedPhone: false,
    verifiedAddress: false,

    status: 'Invited',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  db.tenants.push(tenant);
  property.tenantIds = property.tenantIds || [];

if (!property.tenantIds.includes(tenant.id)) {
  property.tenantIds.push(tenant.id);
}

  audit(db, 'Tenant added for ' + property.address, user);
  write(db);

  res.json({
    success: true,
    tenant,
    tenantInviteLink: `/tenant-setup/${setupToken}`,
    tenantComplianceViewLink: `/tenant-view/${viewToken}`
  });
});

app.put('/api/tenants/:id', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  db.tenants = db.tenants || [];

  const tenant = db.tenants.find(t => t.id === req.params.id);

  if (!tenant) {
    return res.status(404).json({ error: 'Tenant not found' });
  }

  if (user.role !== 'admin' && tenant.landlordEmail !== user.email) {
    return res.status(403).json({ error: 'No access to this tenant' });
  }

  tenant.name = req.body.name || tenant.name;
  tenant.email = req.body.email || tenant.email;
  tenant.phone = req.body.phone || tenant.phone;
  tenant.maintenanceAccess = req.body.maintenanceAccess === true || req.body.maintenanceAccess === 'true';
  tenant.certificateAccess = req.body.certificateAccess === true || req.body.certificateAccess === 'true';
  tenant.updatedAt = new Date().toISOString();

  audit(db, 'Tenant updated for ' + tenant.propertyAddress, user);
  write(db);

  res.json({
    success: true,
    tenant
  });
});

app.delete('/api/tenants/:id', auth, (req, res) => {
  const db = read();
  const user = currentUser(req);

  db.tenants = db.tenants || [];

  const tenant = db.tenants.find(t => t.id === req.params.id);

  if (!tenant) {
    return res.status(404).json({ error: 'Tenant not found' });
  }

  if (user.role !== 'admin' && tenant.landlordEmail !== user.email) {
    return res.status(403).json({ error: 'No access to this tenant' });
  }

  db.tenants = db.tenants.filter(t => t.id !== req.params.id);
  const property = (db.properties || []).find(p => p.id === tenant.propertyId);

if (property) {
  property.tenantIds = (property.tenantIds || []).filter(id => id !== tenant.id);
}

  audit(db, 'Tenant deleted for ' + tenant.propertyAddress, user);
  write(db);

  res.json({ success: true });
});

app.post('/api/tenant-setup/:token', async (req, res) => {
  const db = read();

  db.tenants = db.tenants || [];
  db.users = db.users || [];

  const tenant = db.tenants.find(t => t.tenantSetupToken === req.params.token || t.tenantToken === req.params.token);

  if (!tenant) {
    return res.status(404).json({ error: 'Tenant invite not found' });
  }

  if ((tenant.email || '').toLowerCase() !== (req.body.email || '').toLowerCase()) {
    return res.status(400).json({ error: 'Email does not match the landlord invitation.' });
  }

  if ((tenant.phone || '').replace(/\s/g, '') !== (req.body.phone || '').replace(/\s/g, '')) {
    return res.status(400).json({ error: 'Phone number does not match the landlord invitation.' });
  }

  if (!req.body.password || req.body.password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const existingUser = db.users.find(u => (u.email || '').toLowerCase() === (tenant.email || '').toLowerCase());

if (existingUser) {
    existingUser.role = 'tenant';
    existingUser.tenantId = tenant.id;
    existingUser.propertyId = tenant.propertyId;
    existingUser.linkedPropertyAddress = tenant.propertyAddress || '';
    existingUser.passwordHash = await bcrypt.hash(req.body.password, 10);
    existingUser.updatedAt = new Date().toISOString();
  } else {
   db.users.push({
    id: uuid(),
    name: tenant.name,
    email: tenant.email,
    role: 'tenant',
    tenantId: tenant.id,
    propertyId: tenant.propertyId,
    linkedPropertyAddress: tenant.propertyAddress || '',
    passwordHash: await bcrypt.hash(req.body.password, 10),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
});
  }

  tenant.accountStatus = 'Active';
  tenant.status = 'Active';
  tenant.verifiedEmail = true;
  tenant.verifiedPhone = true;
  tenant.verifiedAddress = true;
  tenant.activatedAt = new Date().toISOString();
  tenant.updatedAt = new Date().toISOString();

  write(db);

  res.json({
    success: true,
    message: 'Tenant account activated successfully.'
  });
});

app.listen(PORT, () => {
  console.log(`Landlord Compliance Hub running on http://localhost:${PORT}`);
});
