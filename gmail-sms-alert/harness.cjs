// Node harness to exercise Code.gs logic with stubbed Apps Script globals.
const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8');

function makeMsg({ from, subject, plainBody, date }) {
  return {
    getFrom: () => from,
    getSubject: () => subject,
    getPlainBody: () => plainBody,
    getDate: () => date
  };
}

function runScenario(name, { scriptProps, twilioResponse, mailThrows }) {
  console.log('\n=== Scenario: ' + name + ' ===');

  const properties = Object.assign({}, scriptProps);
  const labels = {};
  const loggedEmails = [];
  const triggers = [];
  let labelAppliedCount = 0;

  const msg = makeMsg({
    from: 'Sam Baker <samscookies11@gmail.com>',
    subject: 'Your customized cookie order',
    plainBody: 'Hi Andy, Call me at (415) 555-0100 to confirm.  Thanks!   '.repeat(3),
    date: new Date('2026-10-28T15:30:00-05:00')
  });

  const thread = {
    getMessages: () => [msg],
    addLabel: () => { labelAppliedCount++; }
  };

  global.PropertiesService = {
    getScriptProperties: () => ({
      getProperties: () => properties,
      setProperties: (obj) => Object.assign(properties, obj)
    })
  };

  global.GmailApp = {
    search: (query, start, max) => {
      console.log('GmailApp.search query=' + query);
      return [thread];
    },
    getUserLabelByName: (name) => labels[name] || null,
    createLabel: (name) => {
      labels[name] = { name };
      console.log('Created label ' + name);
      return labels[name];
    }
  };

  global.UrlFetchApp = {
    fetch: (url, options) => {
      console.log('UrlFetchApp.fetch -> ' + url);
      if (twilioResponse === 'throw') throw new Error('network error');
      return {
        getResponseCode: () => twilioResponse.code,
        getContentText: () => JSON.stringify(twilioResponse.body)
      };
    }
  };

  global.Utilities = {
    formatDate: (date, tz, fmt) => {
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const h = date.getHours() % 12 || 12;
      const ampm = date.getHours() >= 12 ? 'PM' : 'AM';
      return months[date.getMonth()] + ' ' + date.getDate() + ', ' + date.getFullYear() + ' ' +
        h + ':' + String(date.getMinutes()).padStart(2, '0') + ' ' + ampm + ' ' + tz;
    },
    base64Encode: (str) => Buffer.from(str).toString('base64')
  };

  global.MailApp = {
    sendEmail: (to, subject, body) => {
      if (mailThrows) throw new Error('mail send failed');
      loggedEmails.push({ to, subject, body });
      console.log('MailApp.sendEmail -> ' + to);
    }
  };

  global.ScriptApp = {
    newTrigger: (fn) => ({
      timeBased: () => ({
        everyMinutes: () => ({
          create: () => {
            const t = { getUniqueId: () => 'trigger-' + Math.random().toString(36).slice(2) };
            triggers.push(t);
            return t;
          }
        })
      })
    }),
    getProjectTriggers: () => triggers.map((t, i) => ({
      getHandlerFunction: () => 'checkCustomEmail',
      getUniqueId: () => t.getUniqueId()
    })),
    deleteTrigger: (t) => { console.log('Deleted trigger ' + t.getUniqueId()); }
  };

  global.LockService = {
    getScriptLock: () => ({
      tryLock: () => true,
      releaseLock: () => {}
    })
  };

  const origLog = console.log;
  console.log = (...args) => origLog('  [gs]', ...args);

  const vm = require('vm');
  const sandbox = { console, PropertiesService: global.PropertiesService, GmailApp: global.GmailApp,
    UrlFetchApp: global.UrlFetchApp, Utilities: global.Utilities, MailApp: global.MailApp,
    ScriptApp: global.ScriptApp, LockService: global.LockService, JSON, Buffer, Date, String, Math };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'Code.gs' });

  sandbox.setup();
  sandbox.sendTestSms();

  const smsBody = sandbox.buildSmsBody(msg);
  console.log = origLog;

  console.log('Produced SMS text:\n---\n' + smsBody + '\n---');
  console.log('SMS length: ' + smsBody.length + ' (<=600: ' + (smsBody.length <= 600) + ')');
  console.log('Labels applied this run: ' + labelAppliedCount);
  console.log('Emails sent via gateway: ' + loggedEmails.length);

  return { smsBody, labelAppliedCount, loggedEmails };
}

// Scenario 1: full fake message, no twilio/gateway configured (base SMS text check)
runScenario('Base message / no creds configured', {
  scriptProps: {},
  twilioResponse: { code: 400, body: { message: 'no creds' } }
});

// Scenario 2: Twilio succeeds
runScenario('Twilio success', {
  scriptProps: { TWILIO_SID: 'ACxxx', TWILIO_TOKEN: 'tok', TWILIO_FROM: '+15555550123' },
  twilioResponse: { code: 201, body: { sid: 'SMxxxxx', status: 'queued' } }
});

// Scenario 3: Twilio missing, gateway fallback configured
runScenario('Gateway fallback (no Twilio creds)', {
  scriptProps: { GATEWAY_EMAIL: 'and***@msg.fi.google.com' },
  twilioResponse: { code: 400, body: {} }
});

// Scenario 4: Twilio returns 400, no gateway -> no label applied
runScenario('Twilio 400, no gateway -> should not label', {
  scriptProps: { TWILIO_SID: 'ACxxx', TWILIO_TOKEN: 'tok', TWILIO_FROM: '+15555550123' },
  twilioResponse: { code: 400, body: { message: 'bad request' } }
});
