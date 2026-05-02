const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const admin = require('firebase-admin');
const cors = require('cors');

puppeteer.use(StealthPlugin());
const app = express();
app.use(cors());
app.use(express.json());

// Firebase Key Render ke Environment Variable se aayegi
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

let activeLogins = {};

// 1. Amazon Login Step 1
app.post('/api/amazon/login', async (req, res) => {
    const { phone, email } = req.body;
    try {
        const browser = await puppeteer.launch({
            headless: "new",
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.goto('https://www.amazon.in/ap/signin?...'); // Login URL
        await page.type('#ap_email', phone);
        await page.click('#continue');
        activeLogins[email] = { browser, page };
        res.json({ success: true, message: "OTP Sent" });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

// 2. Amazon OTP Verify
app.post('/api/amazon/verify', async (req, res) => {
    const { email, otp } = req.body;
    const session = activeLogins[email];
    if (!session) return res.json({ success: false, message: "Session Expired" });

    try {
        await session.page.type('input[name="otpCode"]', otp);
        await session.page.click('#auth-signin-button');
        await session.page.waitForNavigation({ waitUntil: 'networkidle2' });
        const cookies = await session.page.cookies();
        await db.collection('sessions').doc(email).set({ cookies, updatedAt: new Date() });
        await session.browser.close();
        delete activeLogins[email];
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

// 3. Auto Check Payments Loop
async function checkPayments() {
    console.log("Checking history...");
    const sessions = await db.collection('sessions').get();
    for (const doc of sessions.docs) {
        const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.setCookie(...doc.data().cookies);
        await page.goto('https://www.amazon.in/amazonpay/transactions');

        const txns = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.a-box-inner')).map(r => ({
                text: r.innerText,
                status: r.querySelector('.transaction-status')?.innerText
            }));
        });

        for (let t of txns) {
            const match = t.text.match(/PAYOUPI[A-Z0-9]+/); // Regex to find Note
            if (match && t.status.includes("Success")) {
                const note = match[0];
                const order = await db.collection('orders').where('payment_note', '==', note).where('status', '==', 'pending').get();
                order.forEach(async o => await o.ref.update({ status: 'Completed', verifiedAt: new Date() }));
            }
        }
        await browser.close();
    }
}
setInterval(checkPayments, 120000); // 2 minutes

app.listen(10000, () => console.log("Server on 10000"));
