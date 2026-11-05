const PHONEPE_BASE_URLS = {
    sandbox: 'https://api-preprod.phonepe.com/apis/pg-sandbox',
    production: 'https://api.phonepe.com/apis/pg'
};

function getPhonePeConfig(env) {
    const requiredSettings = ['PHONEPAY_CLIENT_ID', 'PHONEPAY_CLIENT_SECRET'];
    const missingSettings = requiredSettings.filter(name => !env[name]);
    const environment = String(env.PHONEPAY_ENV || 'sandbox').toLowerCase();

    if (!PHONEPE_BASE_URLS[environment]) {
        throw new Error('PHONEPAY_ENV must be either "sandbox" or "production".');
    }

    return {
        missingSettings,
        environment,
        baseUrl: PHONEPE_BASE_URLS[environment],
        clientId: env.PHONEPAY_CLIENT_ID,
        clientSecret: env.PHONEPAY_CLIENT_SECRET,
        clientVersion: env.PHONEPAY_CLIENT_VERSION || '1'
    };
}

function isPhonePeConfigured(env = process.env) {
    const environment = String(env.PHONEPAY_ENV || 'sandbox').toLowerCase();
    return Boolean(
        env.PHONEPAY_CLIENT_ID &&
        env.PHONEPAY_CLIENT_SECRET &&
        PHONEPE_BASE_URLS[environment]
    );
}

async function readProviderResponse(response, operation) {
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        const detail = result.message || result.error_description || result.code || 'Unknown provider error';
        throw new Error(`PhonePe ${operation} failed (${response.status}): ${detail}`);
    }
    return result;
}

async function getAccessToken(config, fetchImpl) {
    const response = await fetchImpl(`${config.baseUrl}/v1/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: config.clientId,
            client_version: String(config.clientVersion),
            client_secret: config.clientSecret,
            grant_type: 'client_credentials'
        }).toString(),
        signal: AbortSignal.timeout(10000)
    });
    const result = await readProviderResponse(response, 'authorization');
    if (!result.access_token) {
        throw new Error('PhonePe authorization response did not contain an access token.');
    }
    return result.access_token;
}

async function createPayment({
    merchantOrderId,
    amountPaise,
    redirectUrl,
    env = process.env,
    fetchImpl = globalThis.fetch
}) {
    const config = getPhonePeConfig(env);
    if (config.missingSettings.length > 0) {
        return { created: false, missingSettings: config.missingSettings };
    }

    if (!Number.isSafeInteger(amountPaise) || amountPaise < 1) {
        throw new Error('Payment amount must be a positive integer in paise.');
    }

    const accessToken = await getAccessToken(config, fetchImpl);
    const response = await fetchImpl(`${config.baseUrl}/checkout/v2/pay`, {
        method: 'POST',
        headers: {
            Authorization: `O-Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            merchantOrderId,
            amount: amountPaise,
            expireAfter: 1200,
            paymentFlow: {
                type: 'PG_CHECKOUT',
                merchantUrls: { redirectUrl }
            }
        }),
        signal: AbortSignal.timeout(10000)
    });
    const result = await readProviderResponse(response, 'checkout creation');
    if (!result.redirectUrl) {
        throw new Error('PhonePe checkout response did not contain a redirect URL.');
    }

    return {
        created: true,
        redirectUrl: result.redirectUrl,
        providerOrderId: result.orderId || null
    };
}

async function getPaymentStatus({
    merchantOrderId,
    env = process.env,
    fetchImpl = globalThis.fetch
}) {
    const config = getPhonePeConfig(env);
    if (config.missingSettings.length > 0) {
        return { checked: false, missingSettings: config.missingSettings };
    }

    const accessToken = await getAccessToken(config, fetchImpl);
    const response = await fetchImpl(
        `${config.baseUrl}/checkout/v2/order/${encodeURIComponent(merchantOrderId)}/status`,
        {
            method: 'GET',
            headers: { Authorization: `O-Bearer ${accessToken}` },
            signal: AbortSignal.timeout(10000)
        }
    );
    const result = await readProviderResponse(response, 'payment status check');
    return { checked: true, ...result };
}

module.exports = { createPayment, getPaymentStatus, isPhonePeConfigured };
