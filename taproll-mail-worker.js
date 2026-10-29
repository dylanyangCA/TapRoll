// TapRoll automatic parent emails: a Cloudflare Worker.
//
// A few minutes after each class ends, this emails the parents of students marked absent or tardy, once per
// student, class and day. Excused tardies aren't emailed. A tardy that a late pass covers is excused instead.
// Emails come from MAIL_FROM through Resend, and replies go to the teacher.
//
// Only teachers in the schools listed in SCHOOLS get automatic emails (a teacher can still turn them off in
// TapRoll › Settings › Parent emails). Listing schools keeps strangers who sign up from sending email
// from your address.
//
// Cloudflare dashboard › Workers & Pages › this Worker:
//   Settings › Variables and Secrets
//     RESEND_API_KEY            Secret. A Resend API key with sending access.
//     FIREBASE_SERVICE_ACCOUNT  Secret. The whole JSON key of a Google service account that has the
//                               Cloud Datastore User role in your TapRoll Firebase project.
//     MAIL_FROM                 Text. Like: TapRoll <noreply@taprolleducation.com>
//     SCHOOLS                   Text. School IDs that get automatic emails, separated by commas. A school
//                               admin finds the ID in TapRoll › Settings › School. * means every school.
//     Optional, Text:
//     DEFAULT_TZ       Time zone for teachers whose TapRoll hasn't reported one. Default America/Los_Angeles.
//     DELAY_MINUTES    Minutes after class ends before emailing, so marks can be fixed first. Default 5.
//     ACTIVE_HOURS     Hours of the day to work, in DEFAULT_TZ. Default 6-19 (6:00 AM to 7:59 PM).
//     ACTIVE_DAYS      Days to work, 0 = Sunday. Default 1-5 (Monday to Friday).
//     DAILY_LIMIT      Most automatic emails per teacher per day. Default 300.
//   Settings › Trigger Events › Cron Triggers: */10 * * * *  (every 10 minutes)
//
// Every run records itself at site/mail in Firestore, which is how TapRoll knows automatic emails are on.
// Each email is logged at mailLog/<teacher>_<date>_<period>_<student>, so no parent gets the same one twice.
// Logs are deleted after 30 days, in the first runs of each day.

const FIRESTORE = 'https://firestore.googleapis.com/v1';
const RESEND = 'https://api.resend.com/emails/batch';
const PASS_WINDOW = 30;   // a late pass covers a class that starts up to this many minutes after its period ends
const MAX_AGE = 180;      // classes that ended longer ago than this (minutes) aren't emailed about
const KEEP_LOGS = 30;     // days to keep the email log
const EMAIL_RE = /^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"'.]{2,}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
let cachedToken = { key: '', token: '', exp: 0 };

export default {
  async scheduled(event, env) {
    const report = await run(env);
    console.log('TapRoll mail', JSON.stringify(report));
  },
  async fetch() {
    return new Response('TapRoll sends parent emails from here on a schedule. There is nothing to see.', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
};

async function run(env, now = Date.now()) {
  const report = { lastRun: now, ok: true, teachers: 0, sent: 0, failed: 0, excused: 0, held: 0, cleaned: 0, error: '' };
  const allow = String(env.SCHOOLS || '').split(/[\s,]+/).filter((x) => x === '*' || ID_RE.test(x));
  const open = allow.includes('*');
  const cfg = {
    tz: validTz(env.DEFAULT_TZ) || 'America/Los_Angeles',
    delay: num(env.DELAY_MINUTES, 0, 60, 5),
    limit: num(env.DAILY_LIMIT, 1, 5000, 300),
    hours: range(env.ACTIVE_HOURS, 0, 23, [6, 19]),
    days: range(env.ACTIVE_DAYS, 0, 6, [1, 5])
  };
  report.schools = open ? ['*'] : allow;
  report.delay = cfg.delay;
  report.from = String(env.MAIL_FROM || '');
  let fs = null;
  try {
    const sa = serviceAccount(env.FIREBASE_SERVICE_ACCOUNT);
    if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is missing.');
    if (!env.MAIL_FROM) throw new Error('MAIL_FROM is missing. Set it like: TapRoll <noreply@yourdomain.com>');
    fs = firestore(sa.project_id, await accessToken(sa, now));
    // Outside school hours there's nothing to do, so don't spend Firestore reads.
    const here = localNow(cfg.tz, now);
    if (!inRange(here.dow, cfg.days) || !inRange(Math.floor(here.min / 60), cfg.hours)) return await finish(fs, report);
    // First thing each day: delete email logs older than KEEP_LOGS days.
    if (here.min < cfg.hours[0] * 60 + 15) {
      const cutoff = localNow(cfg.tz, now - KEEP_LOGS * 86400000).date;
      const old = await fs.query('', 'mailLog', { field: 'date', op: 'LESS_THAN', value: cutoff }, 300);
      if (old.length) { await fs.write(old.map((d) => ({ path: `mailLog/${d.id}`, remove: true }))); report.cleaned = old.length; }
    }
    if (!open && !allow.length) return await finish(fs, report);

    // 1. Teachers in the listed schools who haven't turned automatic emails off.
    const found = [];
    if (open) found.push(...await fs.query('', 'teachers', { field: 'schoolId', op: 'NOT_EQUAL', value: '' }));
    else for (let i = 0; i < allow.length; i += 30) found.push(...await fs.query('', 'teachers', { field: 'schoolId', op: 'IN', value: allow.slice(i, i + 30) }));
    let teachers = found.map((d) => ({ ...d.data, uid: d.id }))
      .filter((t) => t.mailAuto !== false && ID_RE.test(t.uid) && ID_RE.test(String(t.ws || '')) && ID_RE.test(String(t.schoolId || '')));

    // 2. Teachers write their own profile, so check that each one really is a member of that school.
    const meta = await fs.getMany(teachers.flatMap((t) => [`schools/${t.schoolId}`, `schools/${t.schoolId}/members/${t.uid}`]));
    teachers = teachers.filter((t) => meta.has(`schools/${t.schoolId}`) && meta.has(`schools/${t.schoolId}/members/${t.uid}`));
    report.teachers = teachers.length;
    for (const t of teachers) {
      const member = meta.get(`schools/${t.schoolId}/members/${t.uid}`);
      t.who = clip(t.teacher || member.name || t.name || '', 80);
      t.replyTo = EMAIL_RE.test(String(member.email || '')) ? String(member.email) : '';
      t.schoolName = clip(meta.get(`schools/${t.schoolId}`).name || '', 80);
      t.tz = validTz(t.mailTz) || cfg.tz;
      t.local = localNow(t.tz, now);
      // Turned on today: only classes that end after that.
      const since = Number(t.mailSince) > 0 ? localNow(t.tz, Number(t.mailSince)) : null;
      t.sinceMin = !since || since.date < t.local.date ? -1 : (since.date === t.local.date ? since.min : 24 * 60);
      t.base = `teachers/${t.uid}/ws/${t.ws}`;
      t.dayPath = `${t.base}/days/${t.local.date}`;
    }

    // 3. Absences and tardies in classes that ended a few minutes ago (up to MAX_AGE).
    const docs = await fs.getMany(teachers.flatMap((t) => [`${t.base}/meta/periods`, t.dayPath]));
    const work = [];
    for (const t of teachers) {
      const periods = obj(obj(docs.get(`${t.base}/meta/periods`)).periods);
      t.day = obj(docs.get(t.dayPath));
      t.room = cfg.limit - autoSentToday(t.day);
      for (const [pid, p] of Object.entries(periods)) {
        const end = toMin(obj(p).end);
        if (!ID_RE.test(pid) || end == null || end > t.local.min - cfg.delay || end < t.local.min - MAX_AGE || end <= t.sinceMin) continue;
        for (const [sid, mk] of Object.entries(obj(obj(t.day.periods)[pid]))) {
          if (!ID_RE.test(sid) || !isObj(mk) || mk.n || mk.nf) continue;
          if (mk.s === 'A' || (mk.s === 'T' && !mk.xt)) work.push({ t, pid, p: { ...p, id: pid }, sid, mk, log: `mailLog/${t.uid}_${t.local.date}_${pid}_${sid}` });
        }
      }
    }
    if (!work.length) return await finish(fs, report);

    // 4. Rosters (for parent emails), late passes, and emails already sent.
    const busy = [...new Set(work.map((w) => w.t))];
    const rosters = await fs.getMany(busy.map((t) => `${t.base}/meta/roster`));
    const schoolPasses = new Map();
    for (const w of work) {
      if (w.mk.s !== 'T' || schoolPasses.has(w.t.schoolId)) continue;
      const list = await fs.query(`schools/${w.t.schoolId}`, 'passes', { field: 'date', op: 'EQUAL', value: w.t.local.date });
      schoolPasses.set(w.t.schoolId, list.map((d) => ({ ...d.data, id: d.id })));
    }
    const logs = await fs.getMany(work.map((w) => w.log));

    const marks = [];   // changes to attendance marks: { path, pid, sid, fields }
    const toSend = [];
    for (const w of work) {
      const prior = logs.get(w.log);
      if (prior) {
        // Tried already (the mark changed afterward). Record how it went, so it isn't looked at again.
        marks.push({ path: w.t.dayPath, pid: w.pid, sid: w.sid, fields: prior.status === 'failed' ? { nf: 1 } : { n: Number(prior.sentAt || prior.at) || now, na: 1 } });
        continue;
      }
      const st = obj(obj(obj(rosters.get(`${w.t.base}/meta/roster`)).students)[w.sid]);
      if (!Array.isArray(st.periods) || !st.periods.includes(w.pid)) continue;
      if (w.mk.s === 'T') {
        const own = Object.entries(obj(w.t.day.passes)).map(([id, x]) => ({ ...obj(x), id }));
        const pass = [...own, ...(schoolPasses.get(w.t.schoolId) || [])]
          .find((x) => isObj(x.from) && x.id !== w.mk.px && covers(x, { ...st, id: w.sid }, w.p, w.t.uid));
        if (pass) {
          marks.push({ path: w.t.dayPath, pid: w.pid, sid: w.sid, fields: { s: 'P', xt: 1, why: passWhy(pass), px: pass.id } });
          report.excused++;
          continue;
        }
      }
      const to = [...new Set((Array.isArray(st.parents) ? st.parents : []).filter((e) => typeof e === 'string' && EMAIL_RE.test(e)))].slice(0, 3);
      if (!to.length) continue;
      if (w.t.room <= 0) { report.held++; continue; }
      w.t.room--;
      toSend.push({ w, st, to });
    }

    // 5. Claim each email (so two runs can't both send it), send, then note it on the attendance mark.
    const done = [];
    if (toSend.length) {
      const claimed = await fs.write(toSend.map(({ w, to }) => ({
        path: w.log, exists: false,
        data: { uid: w.t.uid, date: w.t.local.date, period: w.pid, student: w.sid, to, kind: w.mk.s === 'A' ? 'absent' : 'tardy', status: 'sending', at: now }
      })));
      const mine = toSend.filter((x, i) => claimed[i]);
      for (let i = 0; i < mine.length; i += 100) {
        const part = mine.slice(i, i + 100);
        const body = JSON.stringify(part.map(({ w, st, to }) => {
          const m = message(w.t, st, w.p, w.t.local.date, w.mk);
          const one = { from: env.MAIL_FROM, to, subject: m.subject, text: m.text, html: m.html };
          if (w.t.replyTo) one.reply_to = w.t.replyTo;
          return one;
        }));
        let res = null, why = '';
        try {
          // The same batch always gets the same key, so if a reply got lost, sending it again doesn't email twice.
          // Permissive: an email Resend can't accept (like a mistyped address) doesn't hold up the rest.
          const r = await fetch(RESEND, { method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json', 'idempotency-key': await sha256(body), 'x-batch-validation': 'permissive' }, body });
          const j = await r.json().catch(() => ({}));
          if (r.ok) res = j; else why = j.message || j.name || `error ${r.status}`;
        } catch (e) { why = (e && e.message) || 'no answer'; }
        if (!res) {
          // Release them so the next run tries again.
          report.ok = false;
          report.error = safeError(`Resend: ${why}`);
          await fs.write(part.map(({ w }) => ({ path: w.log, remove: true }))).catch(() => {});
          continue;
        }
        // data lists the emails Resend accepted, in order; errors lists the others by their place in the batch.
        const bad = new Map((Array.isArray(res.errors) ? res.errors : []).filter((x) => x && Number.isInteger(x.index)).map((x) => [x.index, clip(x.message || 'not accepted', 200)]));
        const ids = (Array.isArray(res.data) ? res.data : []).map((x) => (x && x.id) || '');
        let next = 0;
        part.forEach(({ w }, k) => {
          if (bad.has(k)) {
            marks.push({ path: w.t.dayPath, pid: w.pid, sid: w.sid, fields: { nf: 1 } });
            done.push({ path: w.log, merge: true, data: { status: 'failed', error: bad.get(k) } });
            report.failed++;
            return;
          }
          marks.push({ path: w.t.dayPath, pid: w.pid, sid: w.sid, fields: { n: now, na: 1 } });
          done.push({ path: w.log, merge: true, data: { status: 'sent', sentAt: now, id: ids[next++] || '' } });
          report.sent++;
        });
        if (i + 100 < mine.length) await sleep(600);   // Resend allows a few requests a second
      }
    }
    const writes = [...markWrites(marks), ...done];
    if (writes.length) await fs.write(writes);
  } catch (e) {
    report.ok = false;
    report.error = safeError((e && e.message) || e);
  }
  return finish(fs, report);
}

async function finish(fs, report) {
  if (fs) {
    const { lastRun, ok, sent, error, from, schools, delay } = report;
    try { await fs.write([{ path: 'site/mail', merge: true, data: { lastRun, ok, sent, error, from, schools, delay } }]); }
    catch (e) { report.ok = false; report.error = report.error || clip(`Couldn’t record the run: ${e.message}`, 300); }
  }
  return report;
}

/* ----- The email ----- */
function message(t, st, p, date, mk) {
  const name = `${clip(st.first || '', 60)} ${clip(st.last || '', 60)}`.trim() || 'Your student';
  const cls = `Period ${clip(p.num, 10)}${p.course ? ` (${clip(p.course, 60)})` : ''}`;
  const d = new Date(`${date}T12:00:00Z`);
  const day = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const short = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  let subject, line;
  if (mk.s === 'A') {
    subject = `${name} was absent from ${cls} on ${short}`;
    line = `${name} was marked absent from ${cls} today, ${day}.`;
  } else {
    const at = localNow(t.tz, Number(mk.t) || 0);
    const bell = toMin(p.start);
    const late = bell == null ? 0 : at.min - bell;
    subject = `${name} was late to ${cls} on ${short}`;
    line = `${name} arrived late to ${cls} today, ${day}, checking in at ${clock(at.min)}${late > 0 ? `, ${late} minute${late === 1 ? '' : 's'} after the bell` : ''}.`;
  }
  const teacher = t.who || 'your student’s teacher';
  const reply = t.replyTo ? `If you have any questions, reply to this email to reach ${teacher}.` : `If you have any questions, please contact ${teacher}.`;
  const sign = [t.who, t.schoolName].filter(Boolean);
  const foot = `TapRoll sent this email for ${teacher} when class ended.`;
  const text = ['Hello,', '', line, '', reply, '', 'Thank you,', ...sign, '', foot].join('\n');
  const html = '<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">'
    + `<p>Hello,</p><p>${escapeHtml(line)}</p><p>${escapeHtml(reply)}</p><p>Thank you,${sign.map((s) => `<br>${escapeHtml(s)}`).join('')}</p>`
    + `<p style="color:#5f6b82;font-size:13px">${escapeHtml(foot)}</p></div>`;
  return { subject, text, html };
}

/* ----- Late passes (the same rule as the app) ----- */
function nameKey(first, last) {
  return String(`${first || ''} ${last || ''}`).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function covers(pass, st, p, uid) {
  const f = pass.from;
  if (pass.by === uid && f.pid === p.id) return false;
  const end = toMin(f.end), start = toMin(p.start);
  if (end == null || start == null || start < end - 2 || start > end + PASS_WINDOW) return false;
  const nk = nameKey(st.first, st.last);
  return (Array.isArray(pass.students) ? pass.students : []).some((e) => isObj(e)
    && ((pass.by === uid && e.id === st.id) || (e.sk && st.sk ? e.sk === st.sk : (!!e.nk && e.nk === nk))));
}
const passWhy = (pass) => clip(`Held by ${clip(pass.byName || '', 80) || 'another teacher'}${Number(pass.from.num) ? ` (P${Number(pass.from.num)})` : ''}`, 100);
function autoSentToday(day) {
  let n = 0;
  for (const per of Object.values(obj(day.periods))) for (const mk of Object.values(obj(per))) if (isObj(mk) && mk.na) n++;
  return n;
}

/* ----- Firestore over REST, signed in as the service account ----- */
function firestore(project, token) {
  const root = `projects/${project}/databases/(default)/documents`;
  const call = async (path, body) => {
    const r = await fetch(`${FIRESTORE}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = (Array.isArray(j) ? j[0] : j) || {};
      throw new Error(`Firestore ${path.split(':').pop()}: ${(e.error && e.error.message) || r.status}`);
    }
    return j;
  };
  return {
    // Documents in parent/collection where field op value (EQUAL, IN, NOT_EQUAL, LESS_THAN), up to limit.
    async query(parent, collection, { field, op, value }, limit) {
      const structuredQuery = { from: [{ collectionId: collection }], where: { fieldFilter: { field: { fieldPath: field }, op, value: enc(value) } } };
      if (limit) structuredQuery.limit = limit;
      const rows = await call(`${root}${parent ? `/${parent}` : ''}:runQuery`, { structuredQuery });
      return (Array.isArray(rows) ? rows : []).filter((x) => x.document).map((x) => ({ id: x.document.name.split('/').pop(), data: decode(x.document.fields) }));
    },
    // A Map of path to data, for the documents that exist.
    async getMany(paths) {
      const out = new Map();
      const unique = [...new Set(paths)];
      for (let i = 0; i < unique.length; i += 100) {
        const rows = await call(`${root}:batchGet`, { documents: unique.slice(i, i + 100).map((p) => `${root}/${p}`) });
        for (const x of Array.isArray(rows) ? rows : []) if (x.found) out.set(x.found.name.slice(root.length + 1), decode(x.found.fields));
      }
      return out;
    },
    // Each write succeeds or fails on its own; returns true or false for each. One write per document.
    //   { path, data }                 replace the document
    //   { path, data, merge: true }    set only these top-level fields
    //   { path, data, exists: false }  create, only if it doesn't exist yet
    //   { path, fields, mask }         update just these field paths (the document has to exist)
    //   { path, remove: true }         delete
    async write(list) {
      const results = [];
      for (let i = 0; i < list.length; i += 400) {
        const part = list.slice(i, i + 400);
        const res = await call(`${root}:batchWrite`, {
          writes: part.map((w) => {
            const name = `${root}/${w.path}`;
            if (w.remove) return { delete: name };
            if (w.mask) return { update: { name, fields: w.fields }, updateMask: { fieldPaths: w.mask }, currentDocument: { exists: true } };
            const one = { update: { name, fields: encFields(w.data) } };
            if (w.merge) one.updateMask = { fieldPaths: Object.keys(w.data).map(quote) };
            if (w.exists === false) one.currentDocument = { exists: false };
            return one;
          })
        });
        const status = Array.isArray(res.status) ? res.status : [];
        part.forEach((w, k) => results.push(!status[k] || !status[k].code));
      }
      return results;
    }
  };
}
// One write per day document, setting just the fields given on each mark: periods.<period>.<student>.<field>
function markWrites(list) {
  const by = new Map();
  for (const m of list) {
    const g = by.get(m.path) || { periods: {}, mask: [] };
    const per = g.periods[m.pid] || (g.periods[m.pid] = {});
    const mk = per[m.sid] || (per[m.sid] = {});
    for (const [k, v] of Object.entries(m.fields)) {
      mk[k] = v;
      const fp = `periods.${quote(m.pid)}.${quote(m.sid)}.${quote(k)}`;
      if (!g.mask.includes(fp)) g.mask.push(fp);
    }
    by.set(m.path, g);
  }
  return [...by.entries()].map(([path, g]) => ({ path, fields: encFields({ periods: g.periods }), mask: g.mask }));
}
const quote = (k) => (/^[A-Za-z_][A-Za-z_0-9]*$/.test(k) ? k : '`' + String(k).replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`');
function enc(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === 'boolean') return { booleanValue: x };
  if (typeof x === 'number') return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (typeof x === 'string') return { stringValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(enc) } };
  return { mapValue: { fields: encFields(x) } };
}
function encFields(o) { const out = {}; for (const [k, v] of Object.entries(o || {})) if (v !== undefined) out[k] = enc(v); return out; }
function decode(fields) { const out = {}; for (const [k, v] of Object.entries(fields || {})) out[k] = value(v); return out; }
function value(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('mapValue' in v) return decode(v.mapValue.fields);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(value);
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  return null;
}

/* ----- Google sign-in for the service account (OAuth 2.0 JWT bearer grant) ----- */
function serviceAccount(raw) {
  let sa = raw;
  if (typeof raw === 'string') { try { sa = JSON.parse(raw); } catch (e) { sa = null; } }
  if (!isObj(sa) || !sa.client_email || !sa.private_key || !sa.project_id) throw new Error('FIREBASE_SERVICE_ACCOUNT has to be the whole JSON key of a service account.');
  return sa;
}
async function accessToken(sa, now) {
  if (cachedToken.key === sa.client_email && cachedToken.exp - 120000 > now) return cachedToken.token;
  const iat = Math.floor(now / 1000);
  const te = new TextEncoder();
  const aud = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const head = b64url(te.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(te.encode(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud, iat, exp: iat + 3600 })));
  let key;
  try {
    const der = Uint8Array.from(atob(String(sa.private_key).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
    key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch (e) { throw new Error('The private key in FIREBASE_SERVICE_ACCOUNT couldn’t be read. Paste the whole JSON key again.'); }
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, te.encode(`${head}.${claims}`));
  const r = await fetch(aud, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${head}.${claims}.${b64url(new Uint8Array(sig))}`
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Google didn’t accept the service account: ${j.error_description || j.error || r.status}`);
  cachedToken = { key: sa.client_email, token: j.access_token, exp: now + (Number(j.expires_in) || 3600) * 1000 };
  return cachedToken.token;
}
function b64url(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function sha256(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return 'taproll-' + Array.from(d.slice(0, 20), (b) => b.toString(16).padStart(2, '0')).join('');
}

/* ----- Small helpers ----- */
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const obj = (x) => (isObj(x) ? x : {});
const clip = (s, n) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').slice(0, n);
// Run errors are shown to teachers, so leave out email addresses.
const safeError = (s) => clip(String(s == null ? '' : s).replace(/[^\s@<>()"',;]+@[^\s@<>()"',;]+/g, '(an address)'), 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function num(v, lo, hi, dflt) { const n = Number(v); return v === undefined || v === null || v === '' || !Number.isFinite(n) ? dflt : Math.max(lo, Math.min(hi, Math.round(n))); }
function range(v, lo, hi, dflt) {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(String(v || ''));
  if (!m) return dflt;
  const a = Number(m[1]), b = Number(m[2]);
  return a >= lo && b <= hi && a <= b ? [a, b] : dflt;
}
const inRange = (x, [a, b]) => x >= a && x <= b;
function validTz(tz) {
  if (!tz || typeof tz !== 'string') return '';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return ''; }
}
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function localNow(tz, ms) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { date: `${v.year}-${v.month}-${v.day}`, min: (Number(v.hour) % 24) * 60 + Number(v.minute), dow: DOW[v.weekday] };
}
function toMin(hm) { const m = /^(\d{1,2}):(\d{2})/.exec(String(hm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
function clock(min) { const h = Math.floor(min / 60); return `${h % 12 || 12}:${String(min % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
