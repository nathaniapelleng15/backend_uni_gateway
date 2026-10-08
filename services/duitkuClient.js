const crypto = require('crypto');

const enabled = () => String(process.env.PAYMENT_PROVIDER || '').trim().toLowerCase() === 'duitku';
const sign = (value, key) => crypto.createHmac('sha256', key).update(value).digest('hex');

function config() {
  const merchantCode = String(process.env.DUITKU_MERCHANT_CODE || '').trim();
  const apiKey = String(process.env.DUITKU_API_KEY || '').trim();
  const environment = process.env.DUITKU_ENV || 'sandbox';
  const paymentMethod = process.env.DUITKU_PAYMENT_METHOD || 'NQ';
  const callbackUrl = process.env.DUITKU_CALLBACK_URL;
  const returnUrl = process.env.DUITKU_RETURN_URL;
  const email = process.env.DUITKU_CUSTOMER_EMAIL;
  if (!merchantCode || !apiKey || !callbackUrl || !returnUrl || !email) {
    throw Object.assign(new Error('Duitku belum dikonfigurasi: isi Merchant Code, API key, callback URL, return URL, dan email checkout di backend.'), { statusCode: 503 });
  }
  if (!['sandbox', 'production'].includes(environment) || !['NQ', 'SP', 'SQ'].includes(paymentMethod)) {
    throw Object.assign(new Error('Konfigurasi environment/metode QRIS Duitku tidak valid.'), { statusCode: 503 });
  }
  for (const value of [callbackUrl, returnUrl]) {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw Object.assign(new Error('URL Duitku harus HTTPS dan dapat diakses publik.'), { statusCode: 503 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('Email checkout Duitku tidak valid.'), { statusCode: 503 });
  return { merchantCode, apiKey, paymentMethod, callbackUrl, returnUrl, email, environment,
    baseUrl: environment === 'sandbox' ? 'https://sandbox.duitku.com' : 'https://passport.duitku.com',
    expiryMinutes: Math.min(60, Math.max(1, Math.floor(Number(process.env.DUITKU_EXPIRY_MINUTES)) || 10)),
  };
}

async function request(path, body, settings, fetcher = fetch) {
  let response, providerStatus;
  try {
    response = await fetcher(`${settings.baseUrl}/webapi/api/merchant/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const contentType = response.headers?.get?.('content-type') || '';
    const server = response.headers?.get?.('server') || '';
    const mitigation = response.headers?.get?.('cf-mitigated') || '';
    if (response.status === 403 && (mitigation === 'challenge'
      || (/cloudflare/i.test(server) && /text\/html/i.test(contentType)))) {
      throw Object.assign(new Error('Duitku edge blocked server request'), { code: 'DUITKU_EDGE_BLOCKED' });
    }
    const data = await response.json();
    providerStatus = /^[0-9]{2}$/.test(String(data.statusCode)) ? String(data.statusCode) : undefined;
    if (!response.ok) throw new Error('Provider rejected request');
    return data;
  } catch (error) {
    const rawCode = error.cause?.code || error.code
      || ({ TimeoutError: 'TIMEOUT', AbortError: 'ABORTED', TypeError: 'NETWORK_ERROR' })[error.name];
    const code = /^[A-Z_0-9]+$/.test(String(rawCode)) ? rawCode : 'REQUEST_FAILED';
    // Log only diagnostic codes, never request bodies, provider messages or secrets.
    const rawRay = response?.headers?.get?.('cf-ray') || '';
    const ray = /^[a-f0-9]{8,32}-[a-z]{3}$/i.test(rawRay) ? rawRay : '';
    console.error(`[Duitku] ${path} failed: http=${response?.status || 'none'} code=${code} provider_status=${providerStatus || 'none'}${ray ? ` cf_ray=${ray}` : ''}`);
    const message = code === 'DUITKU_EDGE_BLOCKED'
      ? `Permintaan backend diblokir Cloudflare Duitku (HTTP 403). Hubungi dukungan Duitku untuk memeriksa akses API dari IP publik server${ray ? `; Ray ID: ${ray}` : ''}.`
      : response
      ? `Duitku menolak atau gagal memproses permintaan (HTTP ${response.status}). Periksa konfigurasi merchant dan metode QRIS.`
      : ['TimeoutError', 'AbortError'].includes(error.name)
        ? 'Duitku tidak merespons dalam 15 detik. Silakan coba kembali.'
        : 'Backend tidak dapat terhubung ke Duitku. Periksa koneksi internet/DNS server, lalu coba kembali.';
    throw Object.assign(new Error(message), { statusCode: 502, code });
  }
}

async function createInvoice(order, settings = config(), fetcher = fetch) {
  const amount = Number(order.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Nominal Duitku harus berupa Rupiah bulat positif.');
  const data = await request('v2/inquiry', {
    merchantCode: settings.merchantCode, paymentAmount: amount,
    paymentMethod: settings.paymentMethod, merchantOrderId: order.orderId,
    productDetails: 'Sesi Photobooth Uni-Smiles', customerVaName: 'Uni-Smiles Customer',
    email: settings.email, itemDetails: [{ name: 'Sesi Photobooth', price: amount, quantity: 1 }],
    callbackUrl: settings.callbackUrl, returnUrl: settings.returnUrl,
    expiryPeriod: settings.expiryMinutes,
    signature: sign(settings.merchantCode + order.orderId + amount, settings.apiKey),
  }, settings, fetcher);
  if (data.statusCode !== '00' || !data.reference || !data.qrString || !data.paymentUrl) {
    const status = /^[0-9]{2}$/.test(String(data.statusCode)) ? data.statusCode : 'unknown';
    console.error(`[Duitku] inquiry invalid response: status=${status} reference=${Boolean(data.reference)} qr=${Boolean(data.qrString)} payment_url=${Boolean(data.paymentUrl)}`);
    throw Object.assign(new Error('Duitku tidak mengembalikan QRIS dinamis yang valid. Periksa aktivasi metode QRIS merchant.'), { statusCode: 502 });
  }
  const paymentUrl = new URL(data.paymentUrl);
  if (paymentUrl.protocol !== 'https:' || !(paymentUrl.hostname === 'duitku.com' || paymentUrl.hostname.endsWith('.duitku.com'))) {
    throw Object.assign(new Error('URL pembayaran Duitku tidak valid.'), { statusCode: 502 });
  }
  return { reference: data.reference, qrString: data.qrString, paymentUrl: paymentUrl.toString() };
}

function validCallback(body, settings = config()) {
  if (body.merchantCode !== settings.merchantCode || !/^\d+$/.test(String(body.amount))
    || typeof body.merchantOrderId !== 'string' || typeof body.signature !== 'string' || !/^[a-f0-9]{64}$/i.test(body.signature)) return false;
  const expected = sign(settings.merchantCode + body.amount + body.merchantOrderId, settings.apiKey);
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(body.signature, 'hex'));
}

async function checkTransaction(orderId, settings = config(), fetcher = fetch) {
  return request('transactionStatus', {
    merchantCode: settings.merchantCode, merchantOrderId: orderId,
    signature: sign(settings.merchantCode + orderId, settings.apiKey),
  }, settings, fetcher);
}

module.exports = { enabled, config, sign, createInvoice, validCallback, checkTransaction };
