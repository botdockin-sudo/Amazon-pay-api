const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const admin = require('firebase-admin');
const cors = require('cors');

puppeteer.use(StealthPlugin());
const app = express();
app.use(cors());
app.use(express.json());

// Firebase Initialization
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

let activeLogins = {};

// --- 1. LOGIN STEP 1 ---
app.post('/api/amazon/login', async (req, res) => {
    const { phone, email } = req.body;
    try {
        const browser = await puppeteer.launch({
            headless: true, // Render par hamesha true rakhein
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process', '--no-zygote']
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');

        await page.goto('https://www.amazon.in/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.in%2Famazonpay%2Ftransactions&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=inflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0', { waitUntil: 'networkidle2' });

        await page.type('#ap_email', phone);
        await page.click('#continue');
        
        activeLogins[email] = { browser, page };
        res.json({ success: true, message: "OTP Sent" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// --- 2. LOGIN STEP 2 ---
app.post('/api/amazon/verify', async (req, res) => {
    const { email, otp } = req.body;
    const session = activeLogins[email];
    if (!session) return res.json({ success: false, message: "Session Expired" });

    try {
        await session.page.type('input[name="otpCode"]', otp); 
        await session.page.click('#auth-signin-button');
        await session.page.waitForNavigation({ waitUntil: 'networkidle2' });

        const cookies = await session.page.cookies();
        await db.collection('sessions').doc(email).set({
            cookies: cookies,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        await session.browser.close();
        delete activeLogins[email];
        res.json({ success: true, message: "Logged in!" });
    } catch (err) {
        res.json({ success: false, message: "Verify failed" });
    }
});

// --- 3. AUTO MONITORING ---
async function monitor() {
    const sessions = await db.collection('sessions').get();
    for (const doc of sessions.docs) {
        const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
        const page = await browser.newPage();
        try {
            await page.setCookie(...doc.data().cookies);
            await page.goto('https://www.amazon.in/amazonpay/transactions');
            const data = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('.a-box-inner')).map(r => ({
                    text: r.innerText,
                    status: r.querySelector('.transaction-status')?.innerText || ""
                }));
            });
            // Matching logic...
        } catch (e) {} finally { await browser.close(); }
    }
}
setInterval(monitor, 300000); // 5 Minutes (RAM kam consume karne ke liye time badha diya)

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server Live on ${PORT}`));
