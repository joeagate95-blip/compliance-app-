let state={user:null,data:null,view:'dashboard',selected:null,filter:null};

const $=s=>document.querySelector(s);
const app=$('#app');

async function api(url,opts={}){
  const r=await fetch(url,opts);
  const txt=await r.text();
  let j={};
  try{j=txt?JSON.parse(txt):{}}catch(e){j={error:txt}}
  if(!r.ok) throw new Error(j.error||'Error');
  return j;
}

function daysLeft(date){if(!date)return '';return Math.ceil((new Date(date)-new Date())/86400000);}
function statusFor(date){const d=daysLeft(date);if(d==='')return 'Stored';if(d<0)return 'Expired';if(d<=60)return 'Due Soon';return 'Valid';}
function statusClass(s){return s==='Expired'?'red':s==='Due Soon'?'amber':'green';}
function fmt(d){return d?new Date(d).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}):'Not set';}

function title(s){
  return ({
    dashboard:'Dashboard',
    properties:'Property Portfolio',
    compliance:'Compliance Centre',
    expiry:'Expiry Dashboard',
  documents:'All Uploaded Documents',
tenants:'Tenant Contracts',
contractorCentre:'Contractor Centre',
reviews:'Property Condition Reviews',
maintenance:'Maintenance Reports',
admin:'Admin Dashboard',
landlordDetails:'Landlord Details'
  })[s]||s;
}

async function init(){
  const me=await api('/api/me');
  state.user=me.user;
  if(!state.user)return renderLogin();
  await load();
  render();
}

async function load(){
  state.data=await api('/api/app');
}

function renderLogin(){
  app.innerHTML=`
  <div class="login">
    <div class="login-card">
      <div class="logo">Landlord Compliance Hub</div>
      <p class="muted">UK landlord compliance platform.</p>
      <form id="login">
        <div class="field"><label>Email</label><input name="email" value="landlord@demo.co.uk"></div>
        <div class="field"><label>Password</label><input name="password" type="password" value="password123"></div>
        <button style="width:100%">Login</button>
      </form>
      <div class="demo">
        <b>Demo accounts</b><br>
        landlord@demo.co.uk<br>
        agent@demo.co.uk<br>
        contractor@demo.co.uk<br>
        tenant@demo.co.uk<br>
        admin@demo.co.uk<br>
        Password: password123
      </div>
    </div>
  </div>`;

  $('#login').onsubmit=async e=>{
    e.preventDefault();
    const fd=new FormData(e.target);
    try{
      const r=await api('/api/login',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(Object.fromEntries(fd))
      });
      state.user=r.user;
      await load();
      render();
    }catch(err){alert(err.message)}
  };
}

function layout(content){
 const nav=[
  'dashboard',
  'properties',
  'compliance',
  'expiry',
  'documents',
  'tenants',
  'contractorCentre',
  'reviews',
  'maintenance',
   'landlordDetails',
  'admin'
];

  app.innerHTML=`
  <div class="shell">
    <aside class="side">
      <div class="logo">Compliance Hub</div>
      <p class="muted">${state.user.name}<br>${state.user.role.replace('_',' ')}</p>
      ${nav.filter(n=>n!=='admin'||state.user.role==='administrator').map(n=>`
        <a href="#" class="${state.view===n?'active':''}" data-view="${n}">${title(n)}</a>
      `).join('')}
      <hr>
      <button class="btn2" id="logout">Logout</button>
    </aside>

    <main class="main">
      <div class="top">
        <div>
          <h1>${title(state.view)}</h1>
          <p class="muted">Simple blue and white compliance management.</p>
        </div>
        <div class="actions">
          <button onclick="openAddDoc()">Upload Document</button>
          <button class="btn2" onclick="openAddProperty()">Add Property</button>
        </div>
      </div>
      ${content}
    </main>
  </div>`;

  document.querySelectorAll('[data-view]').forEach(a=>a.onclick=e=>{
    e.preventDefault();
    state.view=a.dataset.view;
    state.selected=null;
    state.filter=null;
    render();
  });

  $('#logout').onclick=async()=>{
    await api('/api/logout',{method:'POST'});
    state.user=null;
    renderLogin();
  };
}

function render(){
const views={
dashboard,
properties,
compliance,
expiry,
documents,
tenants,
contractorCentre,
reviews,
maintenance,
landlordDetails,
admin
};
  layout((views[state.view]||dashboard)());
}

function allItems(){
  return [
    ...state.data.documents.map(d=>({...d,item:d.category,exp:d.expiryDate,type:'document'})),
    ...state.data.properties.map(p=>({id:p.id,propertyId:p.id,item:'Property Condition Review',title:'Next Review',exp:p.nextConditionReview,type:'review'}))
  ];
}

function dashboard(){
  const props=state.data.properties;
  const docs=state.data.documents;
  const due=docs.filter(d=>statusFor(d.expiryDate)==='Due Soon').length;
  const overdue=docs.filter(d=>statusFor(d.expiryDate)==='Expired').length;
  const jobs=state.data.contractorJobs||[];

  return `
  <div class="grid">
    <button class="card metric-card span3" onclick="state.view='properties';render()">
      <div class="metric">${props.length}</div><b>Properties</b><span>View portfolio</span>
    </button>
    <button class="card metric-card span3" onclick="state.view='documents';render()">
      <div class="metric">${docs.length}</div><b>Documents</b><span>View uploads</span>
    </button>
    <button class="card metric-card span3" onclick="state.view='expiry';state.filter='due';render()">
      <div class="metric amber">${due}</div><b>Due Soon</b><span>Open due list</span>
    </button>
    <button class="card metric-card span3" onclick="state.view='expiry';state.filter='expired';render()">
      <div class="metric red">${overdue}</div><b>Expired</b><span>Open expired list</span>
    </button>

    <div class="card span8">
      <h2>Portfolio</h2>
      ${propertyTable(props)}
    </div>

    <div class="card span4">
      <h2>Quick Links</h2>
      <p><button onclick="state.view='contractorCentre';render()">Open Contractor Centre</button></p>
      <p><button class="btn2" onclick="openContractorLink()">Create Contractor Upload Link</button></p>
      <p><button class="btn2" onclick="openTenantLink()">Create Tenant Maintenance Link</button></p>

      <h2>Contractor Jobs</h2>
      ${jobs.slice(0,4).map(j=>`
        <p>
          <b>${j.complianceType}</b><br>
          ${j.propertyAddress}<br>
          <span class="pill">${j.status}</span>
        </p>
      `).join('')||'<p class="muted">No contractor jobs yet.</p>'}
    </div>
  </div>`;
}

function propertyTable(props){
  return `
  <table>
    <tr><th>Property</th><th>Status</th><th>Last Property Condition Review</th><th>Action</th></tr>
    ${props.map(p=>`
      <tr>
        <td><b>${p.address}</b><br><span class="muted">${p.type}</span></td>
        <td><span class="pill">${p.status}</span></td>
        <td>${fmt(p.lastConditionReview)}</td>
        <td><button class="btn2" onclick="openCompliance('${p.id}')">Open Compliance Page</button></td>
      </tr>
    `).join('')}
  </table>`;
}

function openCompliance(id){
  state.view='compliance';
  state.selected=id;
  render();
}

function properties(){
  return `
  <div class="grid">
    ${state.data.properties.map(p=>{
      const docs=state.data.documents.filter(d=>d.propertyId===p.id);
      return `
      <div class="card span6">
        <h2>${p.address}</h2>
        <p class="muted">${p.type}</p>
        <p><b>Last Property Condition Review:</b> ${fmt(p.lastConditionReview)}</p>
        <p><b>Next Property Condition Review:</b> ${fmt(p.nextConditionReview)}</p>
        <p><b>Compliance Documents:</b> ${docs.length}</p>
        <button onclick="openCompliance('${p.id}')">Open Compliance Page</button>
        <button class="btn2" onclick="openContractorJobModal('${p.id}')">Create Contractor Job</button>
        <button class="btn2" onclick="openTenantLink('${p.id}')">Tenant Maintenance Link</button>
      </div>`;
    }).join('')}
  </div>`;
}

function compliance(){
  const cats=['Gas Safety','Electrical','EICR','PAT Testing','EPC','Legionella','Smoke & CO Alarms','Fire Safety','Tenant Contracts'];
  const props=state.selected?state.data.properties.filter(p=>p.id===state.selected):state.data.properties;

  return `
  <div class="grid">
    ${props.map(p=>`
      <div class="card span12">
        <button class="btn2" onclick="state.view='properties';state.selected=null;render()">Back to Portfolio</button>
        <h2>${p.address}</h2>
        <p class="muted">Correct property compliance page</p>

        <div class="grid">
          ${cats.map(c=>{
            const docs=state.data.documents.filter(d=>d.propertyId===p.id&&d.category===c);
            const latest=docs[0];
            const st=statusFor(latest?.expiryDate);
            return `
            <div class="card span4">
              <h3>${c}</h3>
              <p class="${statusClass(st)}"><b>${st}</b></p>
              <p>Expiry: ${fmt(latest?.expiryDate)}</p>
              <p>Documents: ${docs.length}</p>
              <button class="btn2" onclick="state.view='documents';state.selected='${p.id}';state.filter='${c}';render()">View Documents</button>
              <button class="btn2" onclick="openContractorJobModal('${p.id}','${c}')">Request Contractor</button>
            </div>`;
          }).join('')}
        </div>
      </div>
    `).join('')}
  </div>`;
}

function expiry(){
  let rows=allItems().sort((a,b)=>new Date(a.exp||'2999')-new Date(b.exp||'2999'));

  if(state.filter==='expired') rows=rows.filter(r=>statusFor(r.exp)==='Expired');
  if(state.filter==='due') rows=rows.filter(r=>statusFor(r.exp)==='Due Soon');

  return `
  <div class="tabs">
    <button class="${!state.filter?'active':''}" onclick="state.filter=null;render()">All</button>
    <button class="${state.filter==='due'?'active':''}" onclick="state.filter='due';render()">Due Soon</button>
    <button class="${state.filter==='expired'?'active':''}" onclick="state.filter='expired';render()">Expired</button>
  </div>

  <div class="card">
    <table>
      <tr>
        <th>Property</th>
        <th>Compliance Area</th>
        <th>Expiry / Due Date</th>
        <th>Status</th>
      </tr>

      ${rows.map(r=>{
        const p=state.data.properties.find(x=>x.id===r.propertyId);
        const st=statusFor(r.exp);

        const link = r.fileName
          ? `<a href="/api/download/${r.fileName}" target="_blank">${r.item}</a>`
          : r.item;

        return `
        <tr>
          <td>${p?.address||''}</td>
          <td>
            <b>${link}</b><br>
            <span class="muted">${r.title||''}</span>
          </td>
          <td>${fmt(r.exp)}</td>
          <td class="${statusClass(st)}"><b>${st}</b></td>
        </tr>`;
      }).join('')||'<tr><td colspan="4">No records found.</td></tr>'}
    </table>
  </div>`;
}

function documents(){
  let docs=state.data.documents;

  if(state.selected) docs=docs.filter(d=>d.propertyId===state.selected);
  if(state.filter) docs=docs.filter(d=>d.category===state.filter);

  return `
  <div class="tabs">
    <button onclick="state.selected=null;state.filter=null;render()">All Uploaded Documents</button>
    ${state.data.properties.map(p=>`
      <button onclick="state.selected='${p.id}';state.filter=null;render()">${p.address.split(',')[0]}</button>
    `).join('')}
  </div>

  <div class="card">
    <h2>${state.selected?state.data.properties.find(p=>p.id===state.selected)?.address:'All Uploaded Documents'}</h2>

    <table>
      <tr>
        <th>Property</th>
        <th>Category</th>
        <th>Document</th>
        <th>Issue</th>
        <th>Expiry</th>
        <th>Actions</th>
      </tr>

      ${docs.map(d=>{
        const p=state.data.properties.find(x=>x.id===d.propertyId);

        const docLink = d.fileName
          ? `<a href="/api/download/${d.fileName}" target="_blank"><b>${d.title}</b></a>`
          : `<b>${d.title}</b>`;

        return `
        <tr>
          <td>${p?.address||''}</td>
          <td>${d.category}</td>
          <td>
            ${docLink}<br>
            <span class="muted">${d.notes||''}</span>
          </td>
          <td>${fmt(d.issueDate)}</td>
          <td>${fmt(d.expiryDate)}</td>
          <td>
            <button class="btn2" onclick="openEditDocument('${d.id}')">Edit</button>
            <button class="btn2" onclick="deleteDocument('${d.id}')">Delete</button>
          </td>
        </tr>`;
      }).join('')||'<tr><td colspan="6">No documents uploaded yet.</td></tr>'}
    </table>
  </div>`;
}
function openEditDocument(id){
  const d=state.data.documents.find(x=>x.id===id);
  if(!d){
    alert('Document not found');
    return;
  }

  const categories=[
    'Gas Safety',
    'Electrical',
    'EICR',
    'PAT Testing',
    'EPC',
    'Legionella',
    'Smoke & CO Alarms',
    'Fire Safety',
    'Tenant Contracts'
  ];

  modal(`
    <h2>Edit Document</h2>

    <form id="editDocForm">
      <div class="field">
        <label>Category</label>
        <select name="category">
          ${categories.map(c=>`
            <option value="${c}" ${d.category===c?'selected':''}>${c}</option>
          `).join('')}
        </select>
      </div>

      <div class="field">
        <label>Document Title</label>
        <input name="title" value="${d.title||''}" required>
      </div>

      <div class="field">
        <label>Issue Date</label>
        <input type="date" name="issueDate" value="${d.issueDate||''}">
      </div>

      <div class="field">
        <label>Expiry Date</label>
        <input type="date" name="expiryDate" value="${d.expiryDate||''}">
      </div>

      <div class="field">
        <label>Notes</label>
        <textarea name="notes">${d.notes||''}</textarea>
      </div>

      <button>Save Changes</button>
      <button type="button" class="btn2" onclick="closeModal()">Cancel</button>
    </form>
  `);

  $('#editDocForm').onsubmit=async e=>{
    e.preventDefault();

    await api('/api/documents/'+id,{
      method:'PUT',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(Object.fromEntries(new FormData(e.target)))
    });

    closeModal();
    await load();
    render();
  };
}

async function deleteDocument(id){
  const d=state.data.documents.find(x=>x.id===id);

  if(!d){
    alert('Document not found');
    return;
  }

  if(!confirm('Delete this document? This cannot be undone.')){
    return;
  }

  await api('/api/documents/'+id,{
    method:'DELETE'
  });

  await load();
  render();
}

function tenants(){
  const tenantDocs = state.data.documents.filter(d =>
    d.category === 'Tenant Contracts'
  );

  return `
  <div class="card">
    <h2>Tenant Contracts</h2>
    <p class="muted">
      Signed ASTs, deposit protection certificates, Right to Rent checks, inventories and prescribed information.
    </p>

    <table>
      <tr>
        <th>Property</th>
        <th>Document</th>
        <th>Issue</th>
        <th>Expiry</th>
        <th>Actions</th>
      </tr>

      ${tenantDocs.map(d=>{
        const p=state.data.properties.find(x=>x.id===d.propertyId);

        const docLink = d.fileName
          ? `<a href="/api/download/${d.fileName}" target="_blank"><b>${d.title}</b></a>`
          : `<b>${d.title}</b>`;

        return `
        <tr>
          <td>${p?.address||''}</td>
          <td>
            ${docLink}<br>
            <span class="muted">${d.notes||''}</span>
          </td>
          <td>${fmt(d.issueDate)}</td>
          <td>${fmt(d.expiryDate)}</td>
          <td>
            <button class="btn2" onclick="openEditDocument('${d.id}')">Edit</button>
            <button class="btn2" onclick="deleteDocument('${d.id}')">Delete</button>
          </td>
        </tr>`;
      }).join('')||'<tr><td colspan="5">No tenant documents uploaded yet.</td></tr>'}
    </table>
  </div>`;
}

function contractors(){
  return `
  <div class="grid">
    <div class="card span12">
      <h2>Approved Contractors</h2>
      <p class="muted">Saved contractors for gas, electrical, EPC, legionella and general property compliance.</p>
      <button onclick="state.view='contractorCentre';render()">Open Contractor Centre</button>
    </div>

    ${state.data.contractors.map(c=>`
      <div class="card span4">
        <h2>${c.company}</h2>
        <p><span class="pill">${c.trade}</span></p>
        <p>${c.contactName}<br>${c.email}<br>${c.phone}</p>
        <p><b>${c.accreditation}</b></p>
        <p class="green">${c.approved?'Approved':'Not approved'}</p>
      </div>
    `).join('')}
  </div>

  <div class="card">
    <h2>Add Contractor</h2>
    <form id="contractorForm" class="grid">
      <input name="trade" placeholder="Trade" class="span3">
      <input name="company" placeholder="Company" class="span3">
      <input name="contactName" placeholder="Contact" class="span3">
      <input name="email" placeholder="Email" class="span3">
      <input name="phone" placeholder="Phone" class="span3">
      <input name="accreditation" placeholder="Accreditation" class="span6">
      <button class="span3">Save Contractor</button>
    </form>
  </div>`;
}

function contractorTemplate(type,property,contractor){
  const landlordName=state.user.name||'[Landlord Name]';
  const landlordEmail=state.user.email||'[Email]';
  const landlordPhone='[Landlord phone number]';
  const company='[Landlord company name]';
  const address=property?.address||'[Property Address]';
  const contractorName=contractor?.contactName||contractor?.company||'[Contractor Name]';

  const intro={
    'Gas Safety':'My gas safety certificate is due for renewal. Please can you provide a quote and availability for carrying out the annual gas safety check this year?',
    'EICR':'The EICR/electrical inspection is due. Please can you provide a quote and your earliest availability?',
    'PAT Testing':'PAT testing is due at the property. Please can you confirm your availability and cost?',
    'EPC':'The EPC is due for renewal. Please can you provide a quote and availability?',
    'Legionella':'The legionella risk assessment is due. Please can you provide a quote and availability?',
    'Smoke & CO Alarms':'Smoke and carbon monoxide alarm testing/checking is due. Please can you confirm availability?'
  }[type]||'A compliance item is due. Please can you provide a quote and availability?';

  return `Hi ${contractorName},

${intro}

Property address:
${address}

Landlord details for certificate:
Name: ${landlordName}
Company: ${company}
Email: ${landlordEmail}
Phone: ${landlordPhone}

Please use the job link provided to update the booking status once this has been booked in.

Kind regards,
${landlordName}`;
}

function contractorCentre(){
  const jobs=state.data.contractorJobs||[];
  const types=['Gas Safety','EICR','PAT Testing','EPC','Legionella','Smoke & CO Alarms'];
  const contractors=state.data.contractors||[];

  return `
  <div class="grid">

    <div class="card span12">
      <h2>Contractor Centre</h2>
      <p class="muted">
        Manage approved contractors, create ready-made contractor messages, send job links, and track quote/booked/completed jobs.
      </p>
      <button onclick="openContractorJobModal()">Create Contractor Job / Quote Request</button>
    </div>

    <div class="card span12">
      <h2>Approved Contractors</h2>
      <p class="muted">Saved contractors for gas, electrical, EPC, legionella and general property compliance.</p>

      <div class="grid">
        ${contractors.map(c=>`
          <div class="card span4">
            <h2>${c.company}</h2>
            <p><span class="pill">${c.trade}</span></p>
            <p>${c.contactName}<br>${c.email}<br>${c.phone}</p>
            <p><b>${c.accreditation}</b></p>
            <p class="green">${c.approved?'Approved':'Not approved'}</p>
          </div>
        `).join('')||'<p class="muted">No approved contractors added yet.</p>'}
      </div>
    </div>

    <div class="card span12">
      <h2>Add Contractor</h2>
      <form id="contractorForm" class="grid">
        <input name="trade" placeholder="Trade" class="span3">
        <input name="company" placeholder="Company" class="span3">
        <input name="contactName" placeholder="Contact" class="span3">
        <input name="email" placeholder="Email" class="span3">
        <input name="phone" placeholder="Phone" class="span3">
        <input name="accreditation" placeholder="Accreditation" class="span6">
        <button class="span3">Save Contractor</button>
      </form>
    </div>

    <div class="card span12">
      <h2>Ready-Made Contractor Templates</h2>
      <p class="muted">Click a template to copy a message you can email, text or WhatsApp to an approved contractor.</p>

      <div class="grid">
        ${types.map(t=>`
          <div class="card span4">
            <h3>${t}</h3>
            <p>${t} due template for quote request and booking.</p>
            <button class="btn2" onclick="copySimpleTemplate('${t}')">Copy Template</button>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="card span12">
      <h2>Contractor Jobs</h2>
      <table>
        <tr>
          <th>Property</th>
          <th>Job</th>
          <th>Contractor</th>
          <th>Status</th>
          <th>Booked</th>
          <th>Quote</th>
          <th>Link</th>
        </tr>
        ${jobs.map(j=>`
          <tr>
            <td>${j.propertyAddress||''}</td>
            <td>${j.complianceType||''}</td>
            <td>${j.contractorName||j.contractorEmail||''}</td>
            <td><span class="pill">${j.status||'Requested'}</span></td>
            <td>${j.bookedDate?`${j.bookedDate} ${j.bookedTime||''}`:'Not booked'}</td>
            <td>${j.quotedPrice?`£${j.quotedPrice}`:'Not provided'}</td>
            <td><button class="btn2" onclick="showJobLink('${j.token}')">View Link</button></td>
          </tr>
        `).join('')||'<tr><td colspan="7">No contractor jobs created yet.</td></tr>'}
      </table>
    </div>

  </div>`;
}

function copySimpleTemplate(type){
  const property=state.data.properties[0];
  const contractor=state.data.contractors[0];
  const txt=contractorTemplate(type,property,contractor);
  navigator.clipboard.writeText(txt);
  alert('Template copied.');
}

function openContractorJobModal(propertyId='',type='Gas Safety'){
  const properties=state.data.properties||[];
  const contractors=state.data.contractors||[];
  const jobTypes=['Gas Safety','EICR','PAT Testing','EPC','Legionella','Smoke & CO Alarms','Fire Safety'];

  modal(`
    <h2>Create Contractor Job / Quote Request</h2>
    <p class="muted">This creates a contractor link. The contractor can update quote, booked date, status and notes.</p>

    <form id="contractorJobForm">
      <div class="field">
        <label>Property</label>
        <select name="propertyId" id="jobProperty">
          ${properties.map(p=>`<option value="${p.id}" ${p.id===propertyId?'selected':''}>${p.address}</option>`).join('')}
        </select>
      </div>

      <div class="field">
        <label>Contractor</label>
        <select name="contractorId" id="jobContractor">
          <option value="">Select contractor</option>
          ${contractors.map(c=>`<option value="${c.id}">${c.company} - ${c.trade}</option>`).join('')}
        </select>
      </div>

      <div class="field">
        <label>Job Type</label>
        <select name="complianceType" id="jobType">
          ${jobTypes.map(t=>`<option ${t===type?'selected':''}>${t}</option>`).join('')}
        </select>
      </div>

      <div class="field">
        <label>Landlord Phone</label>
        <input name="landlordPhone" placeholder="Phone number for certificate">
      </div>

      <div class="field">
        <label>Landlord Company Name</label>
        <input name="landlordCompany" placeholder="Company name for certificate">
      </div>

      <div class="field">
        <label>Message to contractor</label>
        <textarea name="message" id="jobMessage" rows="8"></textarea>
      </div>

      <button>Create Contractor Job Link</button>
      <button type="button" class="btn2" onclick="fillJobTemplate()">Generate Template</button>
      <button type="button" class="btn2" onclick="closeModal()">Cancel</button>
    </form>
  `);

  fillJobTemplate();

  $('#contractorJobForm').onsubmit=async e=>{
    e.preventDefault();

    const fd=Object.fromEntries(new FormData(e.target));
    const contractor=contractors.find(c=>c.id===fd.contractorId);

    fd.contractorName=contractor?.company||'';
    fd.contractorEmail=contractor?.email||'';
    fd.landlordName=state.user.name;
    fd.landlordEmail=state.user.email;

    const r=await api('/api/contractor-jobs',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(fd)
    });

    closeModal();
    await load();

    modal(`
      <h2>Contractor Job Created</h2>
      <p>Send this link to the contractor:</p>
      <input value="${r.contractorLink}" onclick="this.select()" style="width:100%">
      <p><a href="${r.contractorLink}" target="_blank">Open contractor job link</a></p>
      <p class="muted">The contractor can update quote, booking date, status and notes.</p>
      <button onclick="closeModal();state.view='contractorCentre';render()">Close</button>
    `);
  };
}

function fillJobTemplate(){
  const propertyId=$('#jobProperty')?.value;
  const contractorId=$('#jobContractor')?.value;
  const type=$('#jobType')?.value||'Gas Safety';
  const property=state.data.properties.find(p=>p.id===propertyId);
  const contractor=state.data.contractors.find(c=>c.id===contractorId);
  const txt=contractorTemplate(type,property,contractor);
  const box=$('#jobMessage');
  if(box)box.value=txt;
}

function showJobLink(token){
  const url=`${location.origin}/contractor-job/${token}`;
  modal(`
    <h2>Contractor Job Link</h2>
    <p>Send this link to the contractor so they can update the job status:</p>
    <input value="${url}" onclick="this.select()" style="width:100%">
    <p><a href="${url}" target="_blank">Open contractor page</a></p>
    <button onclick="navigator.clipboard.writeText('${url}');alert('Link copied')">Copy Link</button>
    <button class="btn2" onclick="closeModal()">Close</button>
  `);
}

function reviews(){
  return `
  <div class="card">
    <h2>Property Condition Reviews</h2>
    ${state.data.reviews.map(r=>{
      const p=state.data.properties.find(x=>x.id===r.propertyId);
      return `
      <div class="card">
        <h3>${p?.address}</h3>
        <p><b>Date:</b> ${fmt(r.date)} | <b>Completed by:</b> ${r.completedBy} | <b>Outcome:</b> ${r.outcome}</p>
        <p>${r.notes}</p>
        <div>${(r.photos||[]).map(ph=>`<img class="photo" src="/uploads/${ph}">`).join('')}</div>
      </div>`;
    }).join('')}
  </div>

  <div class="card">
    <h2>Add Property Condition Review</h2>
    <form id="reviewForm" enctype="multipart/form-data">
      <div class="field"><select name="propertyId">${state.data.properties.map(p=>`<option value="${p.id}">${p.address}</option>`)}</select></div>
      <div class="field"><input type="date" name="date"></div>
      <div class="field"><input name="completedBy" placeholder="Completed by"></div>
      <div class="field"><select name="outcome"><option>Good Condition</option><option>Minor Issues Identified</option><option>Action Required</option></select></div>
      <div class="field"><textarea name="notes" placeholder="Review notes"></textarea></div>
      <div class="field"><input type="file" name="photos" multiple accept="image/*"></div>
      <button>Save Review</button>
    </form>
  </div>`;
}

function maintenance(){
  return `
  <div class="grid">
    <div class="card span6">
      <h2>Maintenance Reports</h2>
      <p><button onclick="openTenantLink()">Create Tenant Maintenance Link</button></p>
      ${state.data.maintenance.map(m=>{
        const p=state.data.properties.find(x=>x.id===m.propertyId);
        return `
        <div class="card">
          <b>${m.title}</b>
          <p>${p?.address||''}</p>
          <p>${m.priority} priority • ${m.status}</p>
          <p>${m.notes||''}</p>
          <p><a href="/api/maintenance/${m.id}/pdf" target="_blank">Download PDF Report</a></p>
        </div>`;
      }).join('')}
    </div>

    <div class="card span6">
      <h2>Report an Issue</h2>
      <form id="maintForm" enctype="multipart/form-data">
        <div class="field"><select name="propertyId">${state.data.properties.map(p=>`<option value="${p.id}">${p.address}</option>`)}</select></div>
        <div class="field"><input name="title" placeholder="Issue title"></div>
        <div class="field"><select name="priority"><option>Low</option><option>Medium</option><option>High</option><option>Urgent</option></select></div>
        <div class="field"><textarea name="notes" placeholder="Details"></textarea></div>
        <div class="field"><input type="file" name="photos" multiple accept="image/*"></div>
        <button>Submit</button>
      </form>
    </div>
  </div>`;
}

function premium(){
  return `
  <div class="grid">
    <div class="card span4"><h2>OCR Extraction</h2><p>Connect OCR to read CP12/EICR dates automatically.</p></div>
    <div class="card span4"><h2>Contractor Scheduling</h2><p>Book contractors against properties and compliance categories.</p></div>
    <div class="card span4"><h2>AI Compliance Risk Checker</h2><p>Future module to flag missing or high-risk compliance areas.</p></div>
  </div>`;
}

function landlordDetails(){

  const user = state.user || {};

  const shareText = `
Landlord Details

Name: ${user.name || ''}
Email: ${user.email || ''}
Phone: ${user.phone || ''}
Company: ${user.company || ''}

Please use the above details when arranging access, certificates or remedial works.
`;

  return `
    <div class="card">
      <h2>Landlord Details</h2>

      <p><b>Name:</b> ${user.name || 'Not set'}</p>
      <p><b>Email:</b> ${user.email || 'Not set'}</p>
      <p><b>Phone:</b> ${user.phone || 'Not set'}</p>
      <p><b>Company:</b> ${user.company || 'Not set'}</p>

      <br>

      <button class="btn"
        onclick="navigator.clipboard.writeText(\`${shareText}\`);
        alert('Landlord details copied to clipboard');">
        Share My Information
      </button>
    </div>
  `;
}
function admin(){
  setTimeout(loadAdminAnalytics,100);

  return `
  <div class="grid">
    <div class="card span12">
      <h2>Platform Analytics</h2>
      <div id="adminAnalytics" class="grid">
        <div class="card span3"><h2>Loading...</h2></div>
      </div>
    </div>

    <div class="card span4">
      <h2>Users</h2>
      ${state.data.users.map(u=>`
        <p><b>${u.name}</b><br>${u.email}<br><span class="pill">${u.role}</span></p>
      `).join('')}
    </div>

    <div class="card span8">
      <h2>All Client Folders / Properties</h2>
      ${propertyTable(state.data.properties)}
    </div>

    <div class="card span12">
      <h2>Audit Log</h2>
      <button onclick="runReminders()">Run Reminder Check</button>
      ${state.data.audit.map(a=>`
        <p><span class="pill">${new Date(a.at).toLocaleString('en-GB')}</span> ${a.action} <span class="muted">${a.user||''}</span></p>
      `).join('')}
    </div>
  </div>`;
}
async function loadAdminAnalytics(){
  try{
    const a=await api('/api/admin-analytics');
    const el=document.getElementById('adminAnalytics');
    if(!el)return;

    el.innerHTML=`
      <div class="card span3"><div class="metric">${a.users}</div><b>Total Users</b></div>
      <div class="card span3"><div class="metric">${a.landlords}</div><b>Landlords</b></div>
      <div class="card span3"><div class="metric">${a.agents}</div><b>Letting Agents</b></div>
      <div class="card span3"><div class="metric">${a.contractors}</div><b>Contractors</b></div>
      <div class="card span3"><div class="metric">${a.tenants}</div><b>Tenants</b></div>
      <div class="card span3"><div class="metric">${a.properties}</div><b>Properties</b></div>
      <div class="card span3"><div class="metric">${a.documents}</div><b>Documents</b></div>
      <div class="card span3"><div class="metric red">${a.expired}</div><b>Expired</b></div>
      <div class="card span3"><div class="metric amber">${a.dueSoon}</div><b>Due Soon</b></div>
      <div class="card span3"><div class="metric">${a.maintenanceOpen}</div><b>Open Maintenance</b></div>
      <div class="card span3"><div class="metric">${a.contractorJobs}</div><b>Contractor Jobs</b></div>
      <div class="card span3"><div class="metric green">${a.bookedJobs}</div><b>Booked Jobs</b></div>`;
  }catch(err){
    const el=document.getElementById('adminAnalytics');
    if(el)el.innerHTML='<p class="red">Could not load analytics</p>';
  }
}

function openAddProperty(){
  modal(`
  <h2>Add Property</h2>
  <form id="propForm">
    <div class="field"><input name="address" placeholder="Full address" required></div>
    <div class="field"><input name="type" placeholder="Property type"></div>
    <button>Save</button>
    <button type="button" class="btn2" onclick="closeModal()">Cancel</button>
  </form>`);

  $('#propForm').onsubmit=async e=>{
    e.preventDefault();
    await api('/api/properties',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(Object.fromEntries(new FormData(e.target)))
    });
    closeModal();
    await load();
    render();
  };
}

function openAddDoc(propertyId=''){
  modal(`
  <h2>Upload Compliance Document</h2>
  <form id="docForm" enctype="multipart/form-data">
    <div class="field">
      <select name="propertyId">${state.data.properties.map(p=>`<option value="${p.id}" ${p.id===propertyId?'selected':''}>${p.address}</option>`)}</select>
    </div>
    <div class="field">
      <select name="category">${['Gas Safety','Electrical','EICR','PAT Testing','EPC','Legionella','Smoke & CO Alarms','Fire Safety','Tenant Contracts'].map(c=>`<option>${c}</option>`).join('')}</select>
    </div>
    <div class="field"><input name="title" placeholder="Document title" required></div>
    <div class="field"><label>Issue date</label><input type="date" name="issueDate"></div>
    <div class="field"><label>Expiry date</label><input type="date" name="expiryDate"></div>
    <div class="field"><input type="file" name="file"></div>
    <div class="field"><textarea name="notes" placeholder="Notes"></textarea></div>
    <button>Upload</button>
    <button type="button" class="btn2" onclick="closeModal()">Cancel</button>
  </form>`);

  $('#docForm').onsubmit=async e=>{
    e.preventDefault();
    await api('/api/documents',{method:'POST',body:new FormData(e.target)});
    closeModal();
    await load();
    render();
  };
}

async function openContractorLink(propertyId=''){
  const pid=propertyId||state.data.properties[0]?.id;
  const r=await api('/api/links/contractor',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({propertyId:pid})
  });

  modal(`
  <h2>Contractor Upload Link</h2>
  <p>Send this link to the contractor. They can upload the completed certificate directly.</p>
  <input value="${location.origin}${r.url}" onclick="this.select()" style="width:100%">
  <p><a href="${r.url}" target="_blank">Open link</a></p>
  <button class="btn2" onclick="closeModal()">Close</button>`);
}

async function openTenantLink(propertyId=''){
  const pid=propertyId||state.data.properties[0]?.id;
  const r=await api('/api/links/tenant-maintenance',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({propertyId:pid})
  });

  modal(`
  <h2>Tenant Maintenance Link</h2>
  <p>Send this link to the tenant. They can upload photos and describe the maintenance problem.</p>
  <input value="${location.origin}${r.url}" onclick="this.select()" style="width:100%">
  <p><a href="${r.url}" target="_blank">Open link</a></p>
  <button class="btn2" onclick="closeModal()">Close</button>`);
}

function modal(html){
  document.body.insertAdjacentHTML('beforeend',`<div class="modal" id="modal"><div>${html}</div></div>`);
}

function closeModal(){
  $('#modal')?.remove();
}

async function runReminders(){
  await api('/api/reminders/run',{method:'POST'});
  await load();
  render();
}

document.addEventListener('submit',async e=>{
  if(e.target.id==='contractorForm'){
    e.preventDefault();
    await api('/api/contractors',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(Object.fromEntries(new FormData(e.target)))
    });
    await load();
    render();
  }

  if(e.target.id==='reviewForm'){
    e.preventDefault();
    await api('/api/reviews',{method:'POST',body:new FormData(e.target)});
    await load();
    render();
  }

  if(e.target.id==='maintForm'){
    e.preventDefault();
    await api('/api/maintenance',{method:'POST',body:new FormData(e.target)});
    await load();
    render();
  }
});

init();
