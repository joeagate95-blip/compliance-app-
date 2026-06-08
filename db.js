const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
function ensure(){ if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true}); if(!fs.existsSync(DB_FILE)) seed(); }
function defaultDb(){
 const hash = bcrypt.hashSync('password123',10);
 const users = [
  {id:uuid(), name:'Joe Landlord', email:'landlord@demo.co.uk', role:'landlord', passwordHash:hash},
  {id:uuid(), name:'Sarah Agent', email:'agent@demo.co.uk', role:'letting_agent', passwordHash:hash},
  {id:uuid(), name:'Ratcliffe & Sons', email:'contractor@demo.co.uk', role:'contractor', passwordHash:hash},
  {id:uuid(), name:'Tom Tenant', email:'tenant@demo.co.uk', role:'tenant', passwordHash:hash},
  {id:uuid(), name:'System Admin', email:'admin@demo.co.uk', role:'administrator', passwordHash:hash}
 ];
 const propertyId = uuid();
 const now = new Date().toISOString();
 return {users, properties:[{id:propertyId, address:'12 King Street, Manchester, M1 1AA', type:'3 Bedroom Semi-Detached', landlordId:users[0].id, agentId:users[1].id, tenantIds:[users[3].id], status:'Compliant', lastConditionReview:'2026-05-12', nextConditionReview:'2026-11-12'}], contractors:[{id:uuid(), trade:'Gas', company:'Ratcliffe & Sons Ltd', contactName:'Joseph Agate', email:'contractor@demo.co.uk', phone:'01234 567890', accreditation:'Gas Safe Registered', approved:true},{id:uuid(), trade:'Electrical', company:'ABC Electrical Services', contactName:'A. Smith', email:'electrician@example.co.uk', phone:'01234 567891', accreditation:'NICEIC Approved Contractor', approved:true}], documents:[{id:uuid(), propertyId, category:'Gas Safety', title:'Gas Safety Certificate CP12', expiryDate:'2026-08-14', issueDate:'2025-08-14', status:'Valid', fileName:'demo-cp12.pdf', notes:'Annual gas safety record stored.'},{id:uuid(), propertyId, category:'EICR', title:'Electrical Installation Condition Report', expiryDate:'2029-03-20', issueDate:'2024-03-20', status:'Valid', fileName:'demo-eicr.pdf', notes:'Satisfactory EICR.'},{id:uuid(), propertyId, category:'PAT Testing', title:'PAT Testing Record', expiryDate:'2027-03-20', issueDate:'2026-03-20', status:'Valid', fileName:'demo-pat.pdf', notes:'Portable appliance checks completed.'},{id:uuid(), propertyId, category:'Tenant Contracts', title:'Signed AST Agreement', expiryDate:'2027-04-01', issueDate:'2026-04-01', status:'Stored', fileName:'demo-ast.pdf', notes:'Signed tenant agreement.'}], reviews:[{id:uuid(), propertyId, date:'2026-05-12', completedBy:'Joseph Agate', outcome:'Good Condition', notes:'Property clean and well maintained. No visible damp or mould. Smoke and CO alarms tested.', photos:[]}], maintenance:[{id:uuid(), propertyId, title:'Tenant reported dripping kitchen tap', priority:'Low', status:'Open', reportedBy:users[3].id, createdAt:now}], reminders:[], audit:[{id:uuid(), at:now, action:'Seeded demo app'}], settings:{reminderDays:[90,60,30,7,1]}};
}
function seed(){ fs.writeFileSync(DB_FILE, JSON.stringify(defaultDb(), null, 2)); }
function read(){ ensure(); return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); }
function write(db){ fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2)); }
module.exports = {read, write, seed, uuid};
