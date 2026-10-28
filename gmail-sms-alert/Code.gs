/**
 * Gmail -> SMS alert for "customized" order emails.
 * Texts +19729777432 (Andy Prevalsky) via Twilio, with an optional
 * carrier email-to-SMS gateway fallback.
 */

var DEFAULT_GMAIL_QUERY =
  '(from:samscookies11@gmail.com OR subject:custom OR subject:customized OR subject:customised)';
var DEFAULT_TO_PHONE = '+19729777432';
var DEFAULT_ALERT_LABEL = 'Rose-SMS-Alerted';
var PHONE_REGEX = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;

/** Reads all settings from Script Properties, applying defaults. */
function getConfig() {
  var p = PropertiesService.getScriptProperties().getProperties();
  return {
    GMAIL_QUERY: p.GMAIL_QUERY || DEFAULT_GMAIL_QUERY,
    TO_PHONE: p.TO_PHONE || DEFAULT_TO_PHONE,
    TWILIO_SID: p.TWILIO_SID || '',
    TWILIO_TOKEN: p.TWILIO_TOKEN || '',
    TWILIO_FROM: p.TWILIO_FROM || '',
    GATEWAY_EMAIL: p.GATEWAY_EMAIL || '',
    ALERT_LABEL: p.ALERT_LABEL || DEFAULT_ALERT_LABEL
  };
}

/** Convenience setter for Script Properties, e.g. setProps({TWILIO_SID: '...'}). */
function setProps(obj) {
  PropertiesService.getScriptProperties().setProperties(obj, false);
}

/** Splits "Name <email>" or bare "email" into { name, email }. */
function parseFrom(fromHeader) {
  var m = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(fromHeader || '');
  if (m) {
    var name = m[1].trim();
    var email = m[2].trim();
    return { name: name || email, email: email };
  }
  var email = (fromHeader || '').trim();
  return { name: email, email: email };
}

/** Collapses whitespace, trims, and truncates a string to maxLen chars. */
function collapseAndTruncate(text, maxLen) {
  var collapsed = (text || '').replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLen ? collapsed.slice(0, maxLen) : collapsed;
}

/** Builds the SMS body for a given Gmail message. */
function buildSmsBody(msg) {
  var from = parseFrom(msg.getFrom());
  var subject = msg.getSubject() || '(no subject)';
  var dateStr = Utilities.formatDate(msg.getDate(), 'America/Chicago', 'MMM d, yyyy h:mm a z');
  var snippet = collapseAndTruncate(msg.getPlainBody(), 220);
  var phoneMatch = PHONE_REGEX.exec(subject + ' ' + msg.getPlainBody());
  var phone = phoneMatch ? phoneMatch[0] : 'none';

  var body =
    'New email: ' + subject + '\n' +
    'From: ' + from.name + ' <' + from.email + '>\n' +
    'Received: ' + dateStr + '\n' +
    snippet + '\n' +
    'Phone in email: ' + phone + '\n' +
    'Reply to this text to follow up.';

  if (body.length > 600) {
    body = body.slice(0, 600);
  }
  return body;
}

/**
 * Sends the alert via Twilio SMS, falling back to an email-to-SMS gateway.
 * Never throws. Returns { ok, route, detail }.
 */
function sendAlert(body) {
  var cfg = getConfig();

  if (cfg.TWILIO_SID && cfg.TWILIO_TOKEN && cfg.TWILIO_FROM) {
    try {
      var url = 'https://api.twilio.com/2010-04-01/Accounts/' + cfg.TWILIO_SID + '/Messages.json';
      var resp = UrlFetchApp.fetch(url, {
        method: 'post',
        payload: { To: cfg.TO_PHONE, From: cfg.TWILIO_FROM, Body: body },
        headers: {
          Authorization: 'Basic ' + Utilities.base64Encode(cfg.TWILIO_SID + ':' + cfg.TWILIO_TOKEN)
        },
        muteHttpExceptions: true
      });
      var code = resp.getResponseCode();
      var json = JSON.parse(resp.getContentText());
      console.log('Twilio response: sid=' + json.sid + ' status=' + json.status + ' code=' + code);

      if (code >= 200 && code < 300) {
        return { ok: true, route: 'twilio', detail: json };
      }
      console.log('Twilio send failed with code ' + code + ': ' + resp.getContentText());
    } catch (e) {
      console.log('Twilio send threw: ' + e);
    }
  } else {
    console.log('Twilio properties missing; skipping Twilio route.');
  }

  if (cfg.GATEWAY_EMAIL) {
    try {
      MailApp.sendEmail(cfg.GATEWAY_EMAIL, '', body);
      console.log('Sent via gateway email: ' + cfg.GATEWAY_EMAIL);
      return { ok: true, route: 'gateway', detail: cfg.GATEWAY_EMAIL };
    } catch (e) {
      console.log('Gateway send threw: ' + e);
      return { ok: false, route: 'none', detail: String(e) };
    }
  }

  console.log('No gateway configured; alert not sent.');
  return { ok: false, route: 'none', detail: 'Twilio unavailable and no GATEWAY_EMAIL set' };
}

/** Main poller: finds matching unlabeled threads and texts Andy about each. */
function checkCustomEmail() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    console.log('Could not obtain lock; another run is in progress.');
    return;
  }

  try {
    var cfg = getConfig();
    var query = cfg.GMAIL_QUERY + ' -label:"' + cfg.ALERT_LABEL + '" newer_than:3d';
    console.log('Searching Gmail with query: ' + query);

    var threads = GmailApp.search(query, 0, 20);
    console.log('Found ' + threads.length + ' matching thread(s).');

    var label = GmailApp.getUserLabelByName(cfg.ALERT_LABEL) || GmailApp.createLabel(cfg.ALERT_LABEL);

    for (var i = 0; i < threads.length; i++) {
      var messages = threads[i].getMessages();
      var msg = messages[messages.length - 1];
      console.log('Processing: ' + msg.getSubject());

      var body = buildSmsBody(msg);
      var result = sendAlert(body);
      console.log('Send result: route=' + result.route + ' ok=' + result.ok);

      if (result.ok) {
        threads[i].addLabel(label);
        console.log('Labeled thread as ' + cfg.ALERT_LABEL);
      } else {
        console.log('Not labeling thread; alert was not sent successfully.');
      }
    }
  } finally {
    lock.releaseLock();
  }
}

/** One-time setup: creates the label and the 5-minute trigger, then runs a check. */
function setup() {
  var cfg = getConfig();

  GmailApp.getUserLabelByName(cfg.ALERT_LABEL) || GmailApp.createLabel(cfg.ALERT_LABEL);

  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'checkCustomEmail') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  var trigger = ScriptApp.newTrigger('checkCustomEmail').timeBased().everyMinutes(5).create();
  console.log('Created trigger: ' + trigger.getUniqueId());

  checkCustomEmail();
}

/** Sends a one-off test SMS to verify Twilio/gateway configuration. */
function sendTestSms() {
  var result = sendAlert('Rose alert test OK');
  console.log('Test result: ' + JSON.stringify(result));
}
