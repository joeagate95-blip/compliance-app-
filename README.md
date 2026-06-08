# Landlord Compliance Hub - Complete Runnable MVP

A complete, runnable UK landlord compliance app you can test locally and upload to GitHub. It includes role-based login, property portfolio, compliance records, expiry dashboard, document storage, tenant contracts, approved contractors, property condition reviews, automated reminder logging, maintenance reporting and mobile photo uploads.

## Demo accounts

All accounts use password:

```text
password123
```

| Role | Email |
|---|---|
| Landlord | landlord@demo.co.uk |
| Letting Agent | agent@demo.co.uk |
| Contractor | contractor@demo.co.uk |
| Tenant | tenant@demo.co.uk |
| Administrator | admin@demo.co.uk |

## Run locally

Install Node.js 18 or newer.

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

## Reset demo data

```bash
npm run seed
```

## Included features

- Login system
- Roles: Landlord, Letting Agent, Contractor, Tenant, Administrator
- Property Portfolio
- Compliance Centre
- Expiry Dashboard
- Document Storage
- Tenant Contracts
- Approved Contractor Directory
- Property Condition Reviews using the wording requested
- Mobile photo upload for condition reviews and maintenance reports
- Automated reminder check/logging
- Premium placeholders: OCR extraction, contractor scheduling, AI compliance risk checker

## Uploads

Uploaded files are stored in:

```text
/uploads
```

For a live production app, use cloud storage such as Amazon S3, Cloudflare R2, Google Cloud Storage or Azure Blob Storage.

## Deployment notes

This app can be pushed to GitHub. For public hosting, use Render, Railway, Fly.io or another Node.js hosting provider. GitHub Pages will not run this because it is a Node/Express backend app.

## Environment variables

Copy `.env.example` to `.env` and set:

```text
SESSION_SECRET=your-secure-secret
PORT=3000
```

SMTP variables are optional and can be connected later for real email delivery.

## Important

This is a runnable MVP, not legal advice and not a substitute for professional compliance review. Before using commercially, you should add privacy policy, terms, backups, secure cloud file storage, encrypted secrets, production database, payment processing, and penetration/security testing.
