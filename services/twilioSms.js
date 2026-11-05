const { URLSearchParams } = require('url');

async function sendOrderSMS({
    to,
    orderId,
    message,
    env = process.env,
    fetchImpl = globalThis.fetch
}) {
    const accountSid = env.TWILIO_ACCOUNT_SID;
    const authToken = env.TWILIO_AUTH_TOKEN;
    const twilioPhone = env.TWILIO_SMS_FROM;
    const missingSettings = [
        ['TWILIO_ACCOUNT_SID', accountSid],
        ['TWILIO_AUTH_TOKEN', authToken],
        ['TWILIO_SMS_FROM', twilioPhone]
    ].filter(([, value]) => !value).map(([name]) => name);

    if (missingSettings.length > 0) {
        return { sent: false, reason: 'not_configured', missingSettings };
    }

    const rawPhone = String(to || '').trim();
    const digits = rawPhone.replace(/\D/g, '');
    let formattedPhone;
    if (/^\+[1-9]\d{7,14}$/.test(rawPhone)) {
        formattedPhone = rawPhone;
    } else if (/^91[6-9]\d{9}$/.test(digits)) {
        formattedPhone = `+${digits}`;
    } else if (/^[6-9]\d{9}$/.test(digits)) {
        formattedPhone = `+91${digits}`;
    } else {
        throw new Error('SMS recipient must be a valid E.164 number or 10-digit Indian mobile number.');
    }

    const form = new URLSearchParams({
        From: twilioPhone,
        To: formattedPhone,
        Body: `[Hyderabadi Kitchen] Order #${orderId}: ${message}`
    });

    const authorization = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const response = await fetchImpl(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
        {
            method: 'POST',
            headers: {
                Authorization: `Basic ${authorization}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: form.toString(),
            signal: AbortSignal.timeout(10000)
        }
    );

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(`Twilio SMS API error (${response.status}): ${result.message || 'Unknown error'}`);
    }

    return { sent: true, messageId: result.sid || null };
}

module.exports = { sendOrderSMS };
